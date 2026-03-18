import express from 'express';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

console.log('🏥 MSK Radiology MCP Server starting...');

// Tool handlers — actual logic lives here
async function handleGetAvailableSlots(args: any) {
  try {
    const { modality, date, time_preference = 'any' } = args;

    const normalizeDate = (input: string): string => {
      const d = new Date(input);
      if (isNaN(d.getTime())) {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        return tomorrow.toISOString().split('T')[0];
      }
      return d.toISOString().split('T')[0];
    };

    const normalizedDate = normalizeDate(date);

    const allSlots = [];
    for (let hour = 9; hour < 17; hour++) {
      for (let min of [0, 30]) {
        const time = `${normalizedDate} ${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00`;
        allSlots.push(time);
      }
    }

    const result = await pool.query(
      `SELECT start_time FROM appointments WHERE modality = $1 AND DATE(start_time) = $2`,
      [modality, normalizedDate]
    );

    const bookedTimes = result.rows.map(r => new Date(r.start_time).toISOString());

    let available = allSlots.filter(slot => !bookedTimes.includes(new Date(slot).toISOString()));

    available = available.filter(slot => {
      const hour = new Date(slot).getHours();
      if (time_preference === 'morning') return hour < 12;
      if (time_preference === 'afternoon') return hour >= 12;
      return true;
    });

    available = available.slice(0, 5);

    if (available.length === 0) {
      return { content: [{ type: 'text', text: `NO_SLOTS_AVAILABLE for ${modality} on ${normalizedDate} (${time_preference}). Ask the patient for another date or time preference.` }] };
    }

    const formatted = available.map(slot => new Date(slot).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }));

    return { content: [{ type: 'text', text: `Available ${modality} slots on ${normalizedDate}${time_preference !== 'any' ? ` (${time_preference})` : ''}: ${formatted.join(', ')}` }] };

  } catch (error) {
    console.error('get_available_slots error:', error);
    return { content: [{ type: 'text', text: 'AVAILABILITY_ERROR' }] };
  }
}

async function handleBookAppointment(args: any) {
  try {
    const { phone, name, modality, body_part, start_time, email, referral, date_of_birth } = args;

    let patientResult = await pool.query('SELECT * FROM patients WHERE phone = $1', [phone]);
    let patient = patientResult.rows[0];

    if (!patient) {
      const newPatient = await pool.query(
        'INSERT INTO patients (phone, name, last_procedure, date_of_birth) VALUES ($1, $2, $3, $4) RETURNING *',
        [phone, name, `${body_part} ${modality}`, date_of_birth || null]
      );
      patient = newPatient.rows[0];
    } else {
      await pool.query(
        'UPDATE patients SET last_procedure = $1, name = $2 WHERE phone = $3',
        [`${body_part} ${modality}`, name, phone]
      );
    }

    await pool.query(
      `INSERT INTO appointments (patient_id, modality, body_part, start_time, email, referral) VALUES ($1, $2, $3, $4, $5, $6)`,
      [patient.id, modality, body_part, start_time, email, referral]
    );

    return { content: [{ type: 'text', text: `BOOKING_CONFIRMED: ${modality} for ${body_part} on ${start_time}.${email ? ` Confirmation will be sent to ${email}.` : ''}` }] };

  } catch (error: any) {
    console.error('book_appointment error:', error);
    // Slot was taken by someone else simultaneously
    if (error.code === '23505') {
      return {
        content: [{
          type: 'text',
          text: 'BOOKING_ERROR_SLOT_TAKEN: That slot was just booked by someone else. Call get_available_slots again to find another available time for the patient.'
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

// Export the setup function
export async function setupMCP(app: express.Express) {

  app.post('/mcp', async (req, res) => {
    const { method, id, params } = req.body;

    console.log(`MCP request: ${method}`);

    // Handle initialize
    if (method === 'initialize') {
      return res.json({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'msk-radiology', version: '1.0.0' }
        }
      });
    }

    // Handle notifications (no response needed)
    if (method === 'notifications/initialized') {
      return res.status(200).end();
    }

    // List all tools
    if (method === 'tools/list') {
      return res.json({
        jsonrpc: '2.0', id,
        result: {
          tools: [
            {
              name: 'get_available_slots',
              description: 'Use this to check available appointment slots. Call this whenever the patient mentions a date, day, or time preference. Keep calling this with updated parameters as the patient refines their preference. If no date is mentioned, use tomorrow as default. time_preference is optional: "morning" = 9am-12pm, "afternoon" = 12pm-5pm, "any" = all day.',
              inputSchema: {
                type: 'object',
                properties: {
                  modality: { type: 'string', enum: ['X-ray', 'MRI', 'Ultrasound'] },
                  date: { type: 'string', description: 'Date in YYYY-MM-DD format or natural language like "tomorrow", "next Monday"' },
                  time_preference: { type: 'string', enum: ['morning', 'afternoon', 'any'], default: 'any' }
                },
                required: ['modality', 'date']
              }
            },
            {
              name: 'book_appointment',
              description: 'Use this to book an appointment once the patient has confirmed their preferred date, time and scan type. Only call this after confirming all details with the patient.',
              inputSchema: {
                type: 'object',
                properties: {
                  phone: { type: 'string', description: 'Patient phone number' },
                  name: { type: 'string', description: 'Patient full name' },
                  modality: { type: 'string', enum: ['X-ray', 'MRI', 'Ultrasound'] },
                  body_part: { type: 'string', description: 'Body part e.g. Knee, Shoulder, Spine' },
                  start_time: { type: 'string', description: 'Appointment start time e.g. 2026-03-18 14:00:00' },
                  email: { type: 'string', description: 'Optional patient email for confirmation' },
                  referral: { type: 'boolean', description: 'Whether patient has a referral' },
                  date_of_birth: { type: 'string', description: 'Optional patient date of birth e.g. 2001-05-17' }
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

    // Call a tool
    if (method === 'tools/call') {
      const { name, arguments: args } = params;
      let result;

      if (name === 'get_available_slots') result = await handleGetAvailableSlots(args);
      else if (name === 'book_appointment') result = await handleBookAppointment(args);
      else if (name === 'log_call_summary') result = await handleLogCallSummary(args);
      else result = { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };

      return res.json({ jsonrpc: '2.0', id, result });
    }

    // Default response
    return res.json({ jsonrpc: '2.0', id, result: {} });
  });

  console.log('🔧 MCP server ready on /mcp');
}