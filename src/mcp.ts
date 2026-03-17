import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Create the MCP server
// This is what Telnyx's Voice AI will connect to
const server = new McpServer({
  name: 'msk-radiology',
  version: '1.0.0',
});

console.log('🏥 MSK Radiology MCP Server starting...');

// Tool 1: Get available appointment slots
// Emma calls this when patient asks for availability
// Keeps getting called as patient refines their preference
server.tool(
  'get_available_slots',
  'Use this to check available appointment slots. Call this whenever the patient mentions a date, day, or time preference. Keep calling this with updated parameters as the patient refines their preference. If no date is mentioned, use tomorrow as default. time_preference is optional: "morning" = 9am-12pm, "afternoon" = 12pm-5pm, "any" = all day.',
  {
    modality: z.enum(['X-ray', 'MRI', 'Ultrasound']),
    date: z.string(),  // e.g. "2026-03-18", "next Monday", "April 2nd"
    time_preference: z.enum(['morning', 'afternoon', 'any']).default('any'),
  },
  async ({ modality, date, time_preference }) => {

    // Normalize date to YYYY-MM-DD format
    // Handles "next Monday", "April 2nd", "tomorrow" etc
    const normalizeDate = (input: string): string => {
      const d = new Date(input);
      if (isNaN(d.getTime())) {
        // fallback to tomorrow if date is invalid
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        return tomorrow.toISOString().split('T')[0];
      }
      return d.toISOString().split('T')[0];
    };

    const normalizedDate = normalizeDate(date);

    // Generate all possible 30-minute slots between 9am and 5pm
    const allSlots = [];
    for (let hour = 9; hour < 17; hour++) {
      for (let min of [0, 30]) {
        const time = `${normalizedDate} ${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00`;
        allSlots.push(time);
      }
    }

    // Find already booked slots for this modality on this date
    const result = await pool.query(
      `SELECT start_time FROM appointments 
       WHERE modality = $1 
       AND DATE(start_time) = $2`,
      [modality, normalizedDate]
    );

    const bookedTimes = result.rows.map(r =>
      new Date(r.start_time).toISOString()
    );

    // Filter out booked slots
    let available = allSlots.filter(slot =>
      !bookedTimes.includes(new Date(slot).toISOString())
    );

    // Filter by time preference
    available = available.filter(slot => {
      const hour = new Date(slot).getHours();
      if (time_preference === 'morning') return hour < 12;
      if (time_preference === 'afternoon') return hour >= 12;
      return true; // 'any'
    });

    // Return next 5 available
    available = available.slice(0, 5);

    if (available.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No available ${time_preference === 'any' ? '' : time_preference} slots for ${modality} on ${normalizedDate}. Please ask the patient for another date or time preference.`
        }]
      };
    }

    // Format nicely for voice: "9:00 AM, 9:30 AM, 10:00 AM"
    const formatted = available.map(slot => {
      const d = new Date(slot);
      return d.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      });
    });

    return {
      content: [{
        type: 'text',
        text: `Available ${modality} slots on ${normalizedDate}${time_preference !== 'any' ? ` (${time_preference})` : ''}: ${formatted.join(', ')}`
      }]
    };
  }
);

// Tool 2: Book an appointment
// Emma calls this once patient has confirmed their preferred slot
// Inserts the appointment into the database
server.tool(
  'book_appointment',
  'Use this to book an appointment once the patient has confirmed their preferred date, time and scan type. Only call this after confirming all details with the patient.',
  {
    phone: z.string(),
    name: z.string(),                                    // patient full name
    modality: z.enum(['X-ray', 'MRI', 'Ultrasound']),
    body_part: z.string(),
    start_time: z.string(),                              // e.g. "2026-03-17 14:00:00"
    email: z.string().optional(),
    referral: z.boolean(),
    date_of_birth: z.string().optional(),                // e.g. "2001-05-17"
  },
  async ({ phone, name, modality, body_part, start_time, email, referral, date_of_birth }) => {
    // First find or create the patient
    let patientResult = await pool.query(
      'SELECT * FROM patients WHERE phone = $1',
      [phone]
    );

    let patient = patientResult.rows[0];

    // If new patient, create them
    if (!patient) {
      const newPatient = await pool.query(
        'INSERT INTO patients (phone, name, last_procedure, date_of_birth) VALUES ($1, $2, $3, $4) RETURNING *',
        [phone, name, `${body_part} ${modality}`, date_of_birth || null]
      );
      patient = newPatient.rows[0];
    } else {
      // Update their last procedure and name
      await pool.query(
        'UPDATE patients SET last_procedure = $1, name = $2 WHERE phone = $3',
        [`${body_part} ${modality}`, name, phone]
      );
    }

    // Book the appointment
    await pool.query(
      `INSERT INTO appointments 
       (patient_id, modality, body_part, start_time, email, referral) 
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [patient.id, modality, body_part, start_time, email, referral]
    );

    return {
      content: [{
        type: 'text',
        text: `Appointment confirmed! ${modality} for ${body_part} booked on ${start_time}. ${email ? `Confirmation will be sent to ${email}.` : ''}`
      }]
    };
  }
);

// Tool 3: Log call summary
// Emma calls this at the end of every call
// Saves a summary to the database for the dashboard
server.tool(
  'log_call_summary',
  'Use this at the end of every call to log a summary of what happened. Always call this before hanging up.',
  {
    phone: z.string(),
    summary: z.string(),
  },
  async ({ phone, summary }) => {
    // Find patient if they exist
    const patientResult = await pool.query(
      'SELECT * FROM patients WHERE phone = $1',
      [phone]
    );

    const patient = patientResult.rows[0];

    // Save call log
    await pool.query(
      `INSERT INTO call_logs (patient_id, phone, summary) 
       VALUES ($1, $2, $3)`,
      [patient?.id || null, phone, summary]
    );

    return {
      content: [{
        type: 'text',
        text: 'Call summary logged successfully.'
      }]
    };
  }
);

// Start the MCP server on port 3001
// (webhook runs on 3000, MCP runs on 3001)
async function main() {
  const transport = new StreamableHTTPServerTransport({
    port: 3001,
  });

  await server.connect(transport);
  console.log('🚀 MCP Server running on port 3001');
}

main().catch(console.error);