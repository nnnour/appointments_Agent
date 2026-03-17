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
// Returns next 5 available 30-minute slots for a given modality and date
server.tool(
  'get_available_slots',
  'Use this to check available appointment slots for a specific scan type and date. Call this when the patient mentions a date or asks for availability.',
  {
    modality: z.enum(['X-ray', 'MRI', 'Ultrasound']),  // scan type
    date: z.string(),  // e.g. "2026-03-17"
  },
  async ({ modality, date }) => {
    // Generate all possible 30-minute slots between 9am and 5pm
    const allSlots = [];
    for (let hour = 9; hour < 17; hour++) {
      for (let min of [0, 30]) {
        const time = `${date} ${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00`;
        allSlots.push(time);
      }
    }

    // Find already booked slots for this modality on this date
    const result = await pool.query(
      `SELECT start_time FROM appointments 
       WHERE modality = $1 
       AND DATE(start_time) = $2`,
      [modality, date]
    );

    const bookedTimes = result.rows.map(r => 
      new Date(r.start_time).toISOString()
    );

    // Filter out booked slots and return next 5 available
    const available = allSlots
      .filter(slot => !bookedTimes.includes(new Date(slot).toISOString()))
      .slice(0, 5);

    if (available.length === 0) {
      return {
        content: [{ type: 'text', text: `No available slots for ${modality} on ${date}. Please suggest another date.` }]
      };
    }

    // Format nicely for voice: "9:00 AM, 9:30 AM, 10:00 AM"
    const formatted = available.map(slot => {
      const d = new Date(slot);
      return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    });

    return {
      content: [{ type: 'text', text: `Available ${modality} slots on ${date}: ${formatted.join(', ')}` }]
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
    phone: z.string(),         // patient's phone number
    modality: z.enum(['X-ray', 'MRI', 'Ultrasound']),  // scan type
    body_part: z.string(),     // e.g. "Knee", "Shoulder"
    start_time: z.string(),    // e.g. "2026-03-17 14:00:00"
    email: z.string().optional(),   // optional email for confirmation
    referral: z.boolean(),     // did patient confirm they have referral?
  },
  async ({ phone, modality, body_part, start_time, email, referral }) => {
    // First find or create the patient
    let patientResult = await pool.query(
      'SELECT * FROM patients WHERE phone = $1',
      [phone]
    );

    let patient = patientResult.rows[0];

    // If new patient, create them
    if (!patient) {
      const newPatient = await pool.query(
        'INSERT INTO patients (phone, name, last_procedure) VALUES ($1, $2, $3) RETURNING *',
        [phone, 'New Patient', `${body_part} ${modality}`]
      );
      patient = newPatient.rows[0];
    } else {
      // Update their last procedure
      await pool.query(
        'UPDATE patients SET last_procedure = $1 WHERE phone = $2',
        [`${body_part} ${modality}`, phone]
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
    phone: z.string(),    // caller's phone number
    summary: z.string(),  // brief summary of what happened on the call
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