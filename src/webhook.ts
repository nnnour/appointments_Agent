import express from 'express';
import pg from 'pg';
import dotenv from 'dotenv';
import { setupMCP } from './mcp.js';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const app = express();
app.use(express.json());

// Telnyx hits this endpoint before every call starts
// It sends the caller's phone number and we return their info
app.post('/api/webhook/dynamic-variables', async (req, res) => {
  try {
    const phone = req.body?.data?.payload?.telnyx_end_user_target;

    console.log(`📞 Incoming call from: ${phone}`);

    // Look up patient by phone number
    const result = await pool.query(
      'SELECT * FROM patients WHERE phone = $1',
      [phone]
    );

    const patient = result.rows[0];

    if (patient) {
      // Returning patient — send their info as dynamic variables
      console.log(`✅ Found patient: ${patient.name}`);
      return res.json({
        dynamic_variables: {
          patient_name: patient.name,
          last_procedure: patient.last_procedure || 'None',
          is_returning: 'yes',
          date_of_birth: patient.date_of_birth || 'None',
          insurance: patient.insurance || 'None',
        },
      });
    } else {
      // New patient — send default values
      console.log('🆕 New patient');
      return res.json({
        dynamic_variables: {
          patient_name: 'Unknown',
          last_procedure: 'None',
          is_returning: 'no',
          insurance: 'None',
        },
      });
    }
  } catch (error) {
    console.error('Webhook error:', error);
    return res.json({
      dynamic_variables: {
        patient_name: 'Unknown',
        last_procedure: 'None',
        is_returning: 'no',
        insurance: 'None',
      },
    });
  }
});

// Serve dashboard
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Get all appointments
app.get('/api/appointments', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.*, p.name, p.phone FROM appointments a 
       JOIN patients p ON a.patient_id = p.id 
       ORDER BY a.start_time DESC`
    );
    res.json(result.rows);
  } catch (error) {
    console.error('appointments error:', error);
    res.status(500).json({ error: 'Failed to fetch appointments' });
  }
});

// Get all call logs
app.get('/api/call-logs', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM call_logs ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (error) {
    console.error('call logs error:', error);
    res.status(500).json({ error: 'Failed to fetch call logs' });
  }
});

// Mount MCP on the same Express app
await setupMCP(app);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🏥 XMU Radiology Assistant is running!`);
  console.log(`🚀 Server running on port ${PORT}`);
});

export default app;