import express from 'express';
import pg from 'pg';
import dotenv from 'dotenv';
import { DateTime } from 'luxon';

dotenv.config();

const { Pool } = pg;

/** All scheduling / “today” / slot boundaries use Pacific time (works on Railway UTC). */
const PACIFIC = 'America/Los_Angeles';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

console.log('🏥 XMU Radiology MCP Server starting...');

type PacificDayInfo = { iso: string; dayName: string; index: number };

function getNext14PacificDays(): PacificDayInfo[] {
  const start = DateTime.now().setZone(PACIFIC).startOf('day');
  const out: PacificDayInfo[] = [];
  for (let i = 0; i < 14; i++) {
    const d = start.plus({ days: i });
    out.push({
      iso: d.toFormat('yyyy-MM-dd'),
      dayName: d.toFormat('EEEE').toLowerCase(),
      index: i
    });
  }
  return out;
}

const normalizeDate = (input: string): string => {
  const next14Days = getNext14PacificDays();

  const lower = input.toLowerCase().trim();

  if (lower === 'today') return next14Days[0]!.iso;
  if (lower === 'tomorrow') return next14Days[1]!.iso;
  if (lower === 'next week') return next14Days[7]!.iso;

  const nextDayMatch = lower.match(/next (monday|tuesday|wednesday|thursday|friday|saturday|sunday)/);
  if (nextDayMatch) {
    const targetDay = nextDayMatch[1];
    if (!targetDay) return next14Days[1]!.iso;
    const occurrences = next14Days.filter(d => d.dayName === targetDay && d.index > 0);
    if (occurrences.length >= 2) return occurrences[1]!.iso;
    if (occurrences.length === 1) return occurrences[0]!.iso;
  }

  const dayMatch = lower.match(/(?:this )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/);
  if (dayMatch) {
    const targetDay = dayMatch[1];
    if (!targetDay) return next14Days[1]!.iso;
    const occurrence = next14Days.find(d => d.dayName === targetDay && d.index > 0);
    if (occurrence) return occurrence.iso;
  }

  const isoTry = DateTime.fromISO(input.trim(), { zone: PACIFIC });
  if (isoTry.isValid) return isoTry.toFormat('yyyy-MM-dd');

  const isoNoZone = DateTime.fromISO(input.trim());
  if (isoNoZone.isValid) return isoNoZone.setZone(PACIFIC).toFormat('yyyy-MM-dd');

  return next14Days[1]!.iso;
};

/** Slot string from get_available_slots: "yyyy-MM-dd HH:mm:ss" in Pacific wall time. */
function parsePacificSlot(slot: string): DateTime | null {
  let dt = DateTime.fromFormat(slot, 'yyyy-MM-dd HH:mm:ss', { zone: PACIFIC });
  if (dt.isValid) return dt;
  dt = DateTime.fromFormat(slot, 'yyyy-MM-dd HH:mm', { zone: PACIFIC });
  return dt.isValid ? dt : null;
}

/** Map DB value to the same Pacific wall-clock key as our slot strings. */
function dbStartTimeToPacificSlotKey(value: unknown): string | null {
  if (value == null) return null;
  let dt: DateTime;
  if (value instanceof Date) {
    dt = DateTime.fromJSDate(value, { zone: 'utc' });
  } else if (typeof value === 'string') {
    dt = DateTime.fromISO(value, { setZone: true });
    if (!dt.isValid) {
      const local = DateTime.fromFormat(value, 'yyyy-MM-dd HH:mm:ss', { zone: PACIFIC });
      if (local.isValid) return local.toFormat('yyyy-MM-dd HH:mm:ss');
      return null;
    }
  } else {
    return null;
  }
  if (!dt.isValid) return null;
  return dt.setZone(PACIFIC).toFormat('yyyy-MM-dd HH:mm:ss');
}

/** Parse book_appointment start_time: Pacific "yyyy-MM-dd HH:mm:ss" or ISO instant (e.g. ...Z). */
function parseAppointmentStartTime(raw: string): DateTime | null {
  const s = raw.trim();
  if (!s) return null;

  let dt = DateTime.fromFormat(s, 'yyyy-MM-dd HH:mm:ss', { zone: PACIFIC });
  if (dt.isValid) return dt;

  dt = DateTime.fromFormat(s, 'yyyy-MM-dd HH:mm', { zone: PACIFIC });
  if (dt.isValid) return dt;

  dt = DateTime.fromISO(s, { setZone: true });
  if (dt.isValid) return dt;

  const t = s.replace(' ', 'T');
  dt = DateTime.fromISO(t, { zone: PACIFIC });
  return dt.isValid ? dt : null;
}

/**
 * Voice agents often see {{telnyx_current_time}} in UTC. In Pacific evening, UTC may already be the
 * *next calendar day*, so the model wrongly says "today" for slots that are actually "tomorrow" in
 * San Francisco. This cue is the source of truth for patient-facing "today" / "tomorrow" wording.
 */
function patientFacingDayCue(normalizedDate: string): string {
  const todayPacific = DateTime.now().setZone(PACIFIC).startOf('day');
  const targetPacific = DateTime.fromFormat(normalizedDate, 'yyyy-MM-dd', { zone: PACIFIC }).startOf('day');
  const human = targetPacific.toFormat('EEEE, MMMM d, yyyy');

  let relative: string;
  if (targetPacific.hasSame(todayPacific, 'day')) relative = 'today';
  else if (targetPacific.hasSame(todayPacific.plus({ days: 1 }), 'day')) relative = 'tomorrow';
  else if (targetPacific.hasSame(todayPacific.minus({ days: 1 }), 'day')) relative = 'yesterday';
  else if (targetPacific < todayPacific) relative = 'that day (already past in Pacific — offer a future date)';
  else relative = targetPacific.toFormat('EEEE');

  const say =
    relative === 'today' || relative === 'tomorrow' || relative === 'yesterday'
      ? `${relative} (${human})`
      : relative.startsWith('that day')
        ? `${human} — ${relative}`
        : `${relative}, ${human}`;

  return `PATIENT_DATE_CUE (Pacific / clinic — ignore UTC wall clocks like telnyx_current_time for "today" or "tomorrow"): Say the appointment is ${say}. Example: "Our earliest X-ray is tomorrow, Friday March 20, at 12:00 PM."`;
}

async function handleGetAvailableSlots(args: any) {
  try {
    const { modality, date, time_preference = 'any' } = args;
    const normalizedDate = normalizeDate(date);

    const allSlots = [];
    for (let hour = 9; hour < 17; hour++) {
      for (let min of [0, 30]) {
        const time = `${normalizedDate} ${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00`;
        allSlots.push(time);
      }
    }

    const dayStartPacific = DateTime.fromFormat(normalizedDate, 'yyyy-MM-dd', { zone: PACIFIC }).startOf('day');
    const dayEndPacific = dayStartPacific.plus({ days: 1 });

    const result = await pool.query(
      `SELECT start_time FROM appointments
       WHERE modality = $1
         AND start_time >= $2
         AND start_time < $3`,
      [modality, dayStartPacific.toUTC().toJSDate(), dayEndPacific.toUTC().toJSDate()]
    );

    const bookedKeys = new Set(
      result.rows
        .map(r => dbStartTimeToPacificSlotKey(r.start_time))
        .filter((k): k is string => Boolean(k))
    );

    const now = DateTime.now();

    let available = allSlots.filter(slot => {
      const slotDt = parsePacificSlot(slot);
      if (!slotDt) return false;
      if (slotDt <= now) return false;
      return !bookedKeys.has(slot);
    });

    available = available.filter(slot => {
      const slotDt = parsePacificSlot(slot);
      if (!slotDt) return false;
      const hour = slotDt.hour;
      if (time_preference === 'morning') return hour < 12;
      if (time_preference === 'afternoon') return hour >= 12;
      return true;
    });

    available = available.slice(0, 5);

    if (available.length === 0) {
      return { content: [{ type: 'text', text: `NO_SLOTS_AVAILABLE for ${modality} on ${normalizedDate} (${time_preference}). Ask the patient for another date or time preference.` }] };
    }

    const formatted = available.map(slot => {
      const slotDt = parsePacificSlot(slot);
      const readable = slotDt
        ? slotDt.toFormat('h:mm a')
        : slot;
      return `${readable} (${slot})`;
    });

    const dayCue = patientFacingDayCue(normalizedDate);
    return {
      content: [{
        type: 'text',
        text: `Available ${modality} slots on ${normalizedDate} (${PACIFIC})${time_preference !== 'any' ? ` (${time_preference})` : ''}. Past times on that day are already excluded. Times: ${formatted.join(', ')}\n\n${dayCue}`
      }]
    };

  } catch (error) {
    console.error('get_available_slots error:', error);
    return { content: [{ type: 'text', text: 'AVAILABILITY_ERROR' }] };
  }
}

async function handleBookAppointment(args: any) {
  try {
    const { phone, name, modality, body_part, start_time, email, referral, date_of_birth, insurance } = args;

    const startDt = parseAppointmentStartTime(String(start_time ?? ''));
    if (!startDt) {
      return {
        content: [{
          type: 'text',
          text: 'BOOKING_ERROR_INVALID_TIME: Could not parse start_time. Use the exact datetime from get_available_slots (Pacific), e.g. 2026-03-18 14:00:00, or a valid ISO timestamp.'
        }]
      };
    }

    if (startDt <= DateTime.now()) {
      return {
        content: [{
          type: 'text',
          text: 'BOOKING_ERROR_PAST_TIME: That appointment time is already in the past. Apologize briefly, call get_available_slots again for the same day (or another day), and offer the patient only times from that response.'
        }]
      };
    }

    const insertInstant = startDt.toUTC().toJSDate();

    let patientResult = await pool.query('SELECT * FROM patients WHERE phone = $1', [phone]);
    let patient = patientResult.rows[0];

    if (!patient) {
      const newPatient = await pool.query(
        'INSERT INTO patients (phone, name, last_procedure, date_of_birth, insurance, email) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        [phone, name, `${body_part} ${modality}`, date_of_birth || null, insurance || null, email || null]
      );
      patient = newPatient.rows[0];
    } else {
      await pool.query(
        'UPDATE patients SET last_procedure = $1, name = $2, insurance = $3, date_of_birth = $4, email = $5 WHERE phone = $6',
        [`${body_part} ${modality}`, name, insurance || patient.insurance, date_of_birth || patient.date_of_birth, email || patient.email, phone]
      );
    }

    await pool.query(
      `INSERT INTO appointments (patient_id, modality, body_part, start_time, email, referral) VALUES ($1, $2, $3, $4, $5, $6)`,
      [patient.id, modality, body_part, insertInstant, email, referral]
    );

    const confirmPacific = startDt.setZone(PACIFIC).toFormat('yyyy-MM-dd h:mm a');
    return { content: [{ type: 'text', text: `BOOKING_CONFIRMED: ${modality} for ${body_part} on ${confirmPacific} (${PACIFIC}).${email ? ` Confirmation will be sent to ${email}.` : ''}` }] };

  } catch (error: any) {
    console.error('book_appointment error:', error);
    if (error.code === '23505') {
      if (error.constraint === 'appointments_modality_start_time_key') {
        return {
          content: [{
            type: 'text',
            text: 'BOOKING_ERROR_SLOT_TAKEN: That slot was just booked by someone else. Call get_available_slots again to find another available time for the patient.'
          }]
        };
      }
      if (error.constraint === 'appointments_patient_id_start_time_key') {
        return {
          content: [{
            type: 'text',
            text: 'BOOKING_ERROR_TIME_CONFLICT: This patient already has an appointment booked at that time. Let the patient know and ask them to choose a different time slot.'
          }]
        };
      }
      // fallback for any other unique constraint violation
      return {
        content: [{
          type: 'text',
          text: 'BOOKING_ERROR_SLOT_TAKEN: That slot is unavailable. Call get_available_slots again to find another available time for the patient.'
        }]
      };
    }
    return { content: [{ type: 'text', text: 'BOOKING_ERROR' }] };
  }
}

async function handleLogCallSummary(args: any) {
  try {
    const { phone, summary } = args;

    const patientResult = await pool.query('SELECT * FROM patients WHERE phone = $1', [phone]);
    const patient = patientResult.rows[0];

    await pool.query(
      `INSERT INTO call_logs (patient_id, phone, summary) VALUES ($1, $2, $3)`,
      [patient?.id || null, phone, summary]
    );

    return { content: [{ type: 'text', text: 'SUMMARY_LOGGED' }] };

  } catch (error) {
    console.error('log_call_summary error:', error);
    return { content: [{ type: 'text', text: 'SUMMARY_ERROR' }] };
  }
}

export async function setupMCP(app: express.Express) {

  app.post('/mcp', async (req, res) => {
    const { method, id, params } = req.body;

    console.log(`MCP request: ${method}`);

    if (method === 'initialize') {
      return res.json({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'XMU-radiology', version: '1.0.0' }
        }
      });
    }

    if (method === 'notifications/initialized') {
      return res.status(200).end();
    }

    if (method === 'tools/list') {
      return res.json({
        jsonrpc: '2.0', id,
        result: {
          tools: [
            {
              name: 'get_available_slots',
              description: 'Use this to check available appointment slots in America/Los_Angeles (Pacific). Call this whenever the patient mentions a date, day, or time preference. Keep calling this with updated parameters as the patient refines their preference. If no date is mentioned, use tomorrow as default. time_preference is optional: "morning" = 9am-12pm, "afternoon" = 12pm-5pm, "any" = all day. Times that are already in the past on the requested day are never returned. The response includes PATIENT_DATE_CUE: you MUST follow it for words like "today" vs "tomorrow" — do not infer those from {{telnyx_current_time}} if it is UTC. Each slot has a human-readable time and the exact datetime in parentheses — always use the exact datetime in parentheses when calling book_appointment.',
              inputSchema: {
                type: 'object',
                properties: {
                  modality: { type: 'string', enum: ['X-ray', 'MRI', 'Ultrasound'] },
                  date: { type: 'string', description: 'Date in YYYY-MM-DD format or natural language like "tomorrow", "next Monday", "Wednesday"' },
                  time_preference: { type: 'string', enum: ['morning', 'afternoon', 'any'], default: 'any' }
                },
                required: ['modality', 'date']
              }
            },
            {
              name: 'book_appointment',
              description: 'Use this to book an appointment once the patient has confirmed their preferred date, time and scan type. Only call this after confirming all details with the patient. Use the exact datetime from get_available_slots response for start_time (Pacific wall time, e.g. 2026-03-18 14:00:00). Bookings in the past are rejected — if that happens, call get_available_slots again and pick a future slot.',
              inputSchema: {
                type: 'object',
                properties: {
                  phone: { type: 'string', description: 'Patient phone number' },
                  name: { type: 'string', description: 'Patient full name' },
                  modality: { type: 'string', enum: ['X-ray', 'MRI', 'Ultrasound'] },
                  body_part: { type: 'string', description: 'Body part e.g. Knee, Shoulder, Spine' },
                  start_time: { type: 'string', description: 'Exact appointment start time from get_available_slots (Pacific), e.g. 2026-03-18 14:00:00, or ISO-8601 instant' },
                  email: { type: 'string', description: 'Optional patient email for confirmation' },
                  referral: { type: 'boolean', description: 'Whether patient has a referral' },
                  date_of_birth: { type: 'string', description: 'Optional patient date of birth e.g. 2001-05-17' },
                  insurance: { type: 'string', description: 'Optional patient insurance provider e.g. Kaiser, Blue Cross' }
                },
                required: ['phone', 'name', 'modality', 'body_part', 'start_time', 'referral']
              }
            },
            {
              name: 'log_call_summary',
              description: 'Use this at the end of every call to log a summary of what happened. Always call this before hanging up.',
              inputSchema: {
                type: 'object',
                properties: {
                  phone: { type: 'string', description: 'Caller phone number' },
                  summary: { type: 'string', description: 'Brief summary of the call' }
                },
                required: ['phone', 'summary']
              }
            }
          ]
        }
      });
    }

    if (method === 'tools/call') {
      const { name, arguments: args } = params;
      let result;

      if (name === 'get_available_slots') result = await handleGetAvailableSlots(args);
      else if (name === 'book_appointment') result = await handleBookAppointment(args);
      else if (name === 'log_call_summary') result = await handleLogCallSummary(args);
      else result = { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };

      return res.json({ jsonrpc: '2.0', id, result });
    }

    return res.json({ jsonrpc: '2.0', id, result: {} });
  });

  console.log('🔧 MCP server ready on /mcp');
}