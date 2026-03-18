import express from 'express';
import pg from 'pg';
import dotenv from 'dotenv';
import { setupMCP } from './mcp.js';

dotenv.config();

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
          is_returning: 'true',
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
          is_returning: 'false',
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
        is_returning: 'false',
        insurance: 'None',
      },
    });
  }
});

// Mount MCP on the same Express app
await setupMCP(app);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

export default app;