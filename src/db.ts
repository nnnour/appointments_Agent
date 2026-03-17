import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// Create a connection pool to PostgreSQL
// A pool manages multiple connections efficiently
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export default pool;