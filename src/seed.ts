import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function seed() {
  console.log('🌱 Seeding database...');

  await pool.query(`
    INSERT INTO patients (phone, name, last_procedure) VALUES
    ('+14156760572', 'Nour Elaifia', 'Knee X-ray')
    ON CONFLICT (phone) DO NOTHING;
  `);

  console.log('✅ Patient seeded');
  console.log('🎉 Done!');

  await pool.end();
}

seed().catch(console.error);