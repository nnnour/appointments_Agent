import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express from 'express';
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
const server = new McpServer({
  name: 'msk-radiology',
  version: '1.0.0',
});

console.log('🏥 MSK Radiology MCP Server starting...');

// Tool 1: Get available appointment slots
server.tool(
  'get_available_slots',
  'Use this to check available appointment slots. Call this whenever the patient mentions a date, day, or time preference. Keep calling this with updated parameters as the patient refines their preference. If no date is mentioned, use tomorrow as default. time_preference is optional: "morning" = 9am-12pm, "afternoon" = 12pm-5pm, "any" = all day.',
  {
    modality: z.enum(['X-ray', 'MRI', 'Ultrasound']),
    date: z.string(),
    time_preference: z.enum(['morning', 'afternoon', 'any']).default('any'),
  },
  async ({ modality, date, time_preference }) => {
    try {
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
        `SELECT start_time FROM appointments 
         WHERE modality = $1 
         AND DATE(start_time) = $2`,
        [modality, normalizedDate]
      );

      const bookedTimes = result.rows.map(r =>
        new Date(r.start_time).toISOString()
      );

      let available = allSlots.filter(slot =>
        !bookedTimes.includes(new Date(slot).toISOString())
      );

      available = available.filter(slot => {
        const hour = new Date(slot).getHours();
        if (time_preference === 'morning') return hour < 12;
        if (time_preference === 'afternoon') return hour >= 12;
        return true;
      });

      available = available.slice(0, 5);

      if (available.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `NO_SLOTS_AVAILABLE for ${modality} on ${normalizedDate} (${time_preference}). Ask the patient for another date or time preference.`
          }]
        };
      }

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

    } catch (error) {
      console.error('get_available_slots error:', error);
      return {
        content: [{
          type: 'text',
          text: 'AVAILABILITY_ERROR'
        }]
      };
    }
  }
);

// Tool 2: Book an appointment
server.tool(
  'book_appointment',
  'Use this to book an appointment once the patient has confirmed their preferred date, time and scan type. Only call this after confirming all details with the patient.',
  {
    phone: z.string(),
    name: z.string(),
    modality: z.enum(['X-ray', 'MRI', 'Ultrasound']),
    body_part: z.string(),
    start_time: z.string(),
    email: z.string().optional(),
    referral: z.boolean(),
    date_of_birth: z.string().optional(),
  },
  async ({ phone, name, modality, body_part, start_time, email, referral, date_of_birth }) => {
    try {
      let patientResult = await pool.query(
        'SELECT * FROM patients WHERE phone = $1',
        [phone]
      );

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
        `INSERT INTO appointments 
         (patient_id, modality, body_part, start_time, email, referral) 
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [patient.id, modality, body_part, start_time, email, referral]
      );

      return {
        content: [{
          type: 'text',
          text: `BOOKING_CONFIRMED: ${modality} for ${body_part} on ${start_time}.${email ? ` Confirmation will be sent to ${email}.` : ''}`
        }]
      };

    } catch (error) {
      console.error('book_appointment error:', error);
      return {
        content: [{
          type: 'text',
          text: 'BOOKING_ERROR'
        }]
      };
    }
  }
);

// Tool 3: Log call summary
server.tool(
  'log_call_summary',
  'Use this at the end of every call to log a summary of what happened. Always call this before hanging up.',
  {
    phone: z.string(),
    summary: z.string(),
  },
  async ({ phone, summary }) => {
    try {
      const patientResult = await pool.query(
        'SELECT * FROM patients WHERE phone = $1',
        [phone]
      );

      const patient = patientResult.rows[0];

      await pool.query(
        `INSERT INTO call_logs (patient_id, phone, summary) 
         VALUES ($1, $2, $3)`,
        [patient?.id || null, phone, summary]
      );

      return {
        content: [{
          type: 'text',
          text: 'SUMMARY_LOGGED'
        }]
      };

    } catch (error) {
      console.error('log_call_summary error:', error);
      return {
        content: [{
          type: 'text',
          text: 'SUMMARY_ERROR'
        }]
      };
    }
  }
);

// Export the setup function to be called from the main Express app
export async function setupMCP(app: express.Express) {
  const transports: Record<string, SSEServerTransport> = {};

  // SSE endpoint — Telnyx connects here first
  app.get('/mcp', async (req, res) => {
    const transport = new SSEServerTransport('/mcp/messages', res);
    transports[transport.sessionId] = transport;

    res.on('close', () => {
      delete transports[transport.sessionId];
    });

    await server.connect(transport);
    console.log('🔧 MCP SSE client connected');
  });

  // Handle POST to /mcp directly (for validation requests)
  app.post('/mcp', async (req, res) => {
    res.status(200).json({ status: 'ok', message: 'Use GET /mcp for SSE connection' });
  });

  // Messages endpoint — Telnyx sends tool calls here
  app.post('/mcp/messages', async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = transports[sessionId];
    if (transport) {
      await transport.handlePostMessage(req, res);
    } else {
      // Return 200 for unknown sessions to avoid blocking validation
      res.status(200).json({ status: 'ok' });
    }
  });

  console.log('🔧 MCP SSE server ready on /mcp');
}