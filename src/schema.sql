-- Stores patient information
-- Phone is unique so we can identify callers
CREATE TABLE IF NOT EXISTS patients (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         VARCHAR(20) UNIQUE NOT NULL,
  name          VARCHAR(100) NOT NULL,
  last_procedure VARCHAR(100),       -- e.g. "Knee X-ray" - used to personalize greeting
  date_of_birth  DATE                -- collected during booking for patient records
);

-- Stores each booked appointment
-- One patient can have multiple appointments
CREATE TABLE IF NOT EXISTS appointments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id  UUID REFERENCES patients(id),
  modality    VARCHAR(50) NOT NULL CHECK (modality IN ('X-ray', 'MRI', 'Ultrasound')),
  body_part   VARCHAR(50) NOT NULL,   -- "Knee", "Shoulder", "Spine"
  start_time  TIMESTAMP NOT NULL,     -- booked date and time slot
  email       VARCHAR(100),           -- optional, for confirmation
  referral    BOOLEAN DEFAULT FALSE,  -- did patient confirm referral?
  created_at  TIMESTAMP DEFAULT NOW(),

  -- One modality machine per time slot
  UNIQUE (modality, start_time),

  -- Same patient can't have 2 appointments at the same time
  UNIQUE (patient_id, start_time)
);

-- Logs a summary of every call for the dashboard
CREATE TABLE IF NOT EXISTS call_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id  UUID REFERENCES patients(id),
  phone       VARCHAR(20) NOT NULL,  -- caller's phone number
  summary     TEXT NOT NULL,         -- AI generated summary
  created_at  TIMESTAMP DEFAULT NOW()
);