# AI Voice Appointment Booking Agent

An AI voice agent that handles end-to-end appointment booking for a clinic via phone. Built on the Telnyx Voice AI platform with a custom MCP server, PostgreSQL backend, and a live appointment dashboard.

🌐 **Dashboard:** https://appointmentsagent-production.up.railway.app/dashboard
🔧 **Live URL:** https://appointmentsagent-production.up.railway.app

---

## Try It Out

The easiest way to test the agent is to simply call:

📞 **+1 (415) 918-5869**

The agent is live and fully deployed. No setup required.

---

## Use Case

Clinics spend significant staff time on the phone booking appointments verifying referrals, explaining prep instructions, checking availability, and collecting patient info. This AI agent automates the entire flow end-to-end, handling it in under 3 minutes while personalizing the experience for returning patients.

---

## Architecture

```
Incoming Call
     │
     ▼
Telnyx Voice AI Agent
     │
     ├── Dynamic Variables Webhook (fires before call starts)
     │     └── Looks up caller by phone number
     │         └── Returns: patient_name, is_returning, insurance,
     │                      last_procedure, date_of_birth
     │
     ├── MCP Server (called during conversation)
     │     ├── get_available_slots → queries DB for open slots
     │     ├── book_appointment   → creates/updates patient + appointment
     │     └── log_call_summary   → saves AI-generated call summary
     │
     └── PostgreSQL Database
           ├── patients      — phone, name, DOB, insurance, email, last_procedure
           ├── appointments  — modality, body_part, start_time, referral
           └── call_logs     — phone, summary, created_at
```

Both the MCP server and the dynamic variables webhook run on the same Express server deployed on Railway.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Voice AI Platform | Telnyx AI Assistants |
| Backend | TypeScript + Express |
| Database | PostgreSQL via `pg` connection pool |
| MCP Protocol | Raw JSON-RPC 2.0 |
| Deployment | Railway |
| Dashboard | HTML/CSS/JS served by Express |

---

## Project Structure

```
src/
  index.ts        — entry point
  webhook.ts      — Express server, dynamic variables webhook, API routes, dashboard
  mcp.ts          — Raw JSON-RPC MCP server with 3 tools
  schema.sql      — Database schema
  dashboard.html  — Live appointment dashboard
```

---

## Database Schema

### patients
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | auto-generated |
| phone | VARCHAR UNIQUE | used to identify returning callers |
| name | VARCHAR | |
| last_procedure | VARCHAR | e.g. "left knee MRI" — used for personalization |
| date_of_birth | DATE | |
| insurance | VARCHAR | |
| email | VARCHAR | |

### appointments
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| patient_id | UUID FK | references patients |
| modality | VARCHAR | CHECK IN ('X-ray', 'MRI', 'Ultrasound') |
| body_part | VARCHAR | |
| start_time | TIMESTAMP | |
| email | VARCHAR | for confirmation |
| referral | BOOLEAN | |
| created_at | TIMESTAMP | |

Two UNIQUE constraints:
- `(modality, start_time)` — prevents double-booking the same machine
- `(patient_id, start_time)` — prevents a patient booking two appointments at the same time

### call_logs
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| patient_id | UUID FK | |
| phone | VARCHAR | |
| summary | TEXT | AI-generated summary of the call |
| created_at | TIMESTAMP | |

---

## MCP Tools

### `get_available_slots`
Checks real-time availability for a given modality and date. Supports natural language dates ("tomorrow", "next Monday", "Friday") with Pacific timezone normalization. Filters out already-booked slots and returns up to 5 available times.

**Parameters:** `modality`, `date`, `time_preference` (morning/afternoon/any)

**Returns:** Human-readable times with exact datetimes in parentheses for accurate booking:
```
9:00 AM (2026-03-24 09:00:00), 9:30 AM (2026-03-24 09:30:00)
```

### `book_appointment`
Creates a new patient record (or updates an existing one) and inserts an appointment. Handles two distinct error cases:
- `BOOKING_ERROR_SLOT_TAKEN` — someone else just booked that modality+time
- `BOOKING_ERROR_TIME_CONFLICT` — this patient already has an appointment at that time

**Parameters:** `phone`, `name`, `modality`, `body_part`, `start_time`, `email`, `referral`, `date_of_birth`, `insurance`

### `log_call_summary`
Inserts a call log with an AI-generated summary of what happened during the call.

**Parameters:** `phone`, `summary`

---

## Dynamic Variables Webhook

Telnyx calls `POST /api/webhook/dynamic-variables` before every call starts, passing the caller's phone number. The server looks up the patient and returns personalized data:

**Returning patient:**
```json
{
  "dynamic_variables": {
    "patient_name": "Nour Elaifia",
    "is_returning": "yes",
    "insurance": "Blue Shield",
    "last_procedure": "left knee MRI",
    "date_of_birth": "2001-05-17"
  }
}
```

**New patient:**
```json
{
  "dynamic_variables": {
    "patient_name": "Unknown",
    "is_returning": "no",
    "insurance": "None",
    "last_procedure": "None"
  }
}
```

These variables are injected into the agent's instructions before the conversation begins, personalized conversation flow based on patient history

If the webhook times out or fails, safe fallback values are returned so the call continues normally.

---

## Dashboard

Live at `/dashboard`. Auto-refreshes every 15 seconds.

- **Stats row:** total bookings
- **Calendar:** 3-column grid showing booked slots by modality with patient name and body part
- **Date tabs:** next 14 days + any dates with bookings beyond that window
- **Recent bookings:** 10 most recent appointments sorted by booking time

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/api/webhook/dynamic-variables` | Telnyx pre-call webhook |
| POST | `/mcp` | MCP JSON-RPC endpoint |
| GET | `/api/appointments` | All appointments with patient info |
| GET | `/api/call-logs` | All call logs |
| GET | `/dashboard` | Live appointment dashboard |

---

## Local Development

To run the backend server locally you need:
- Node.js 18+
- A PostgreSQL database
- A `.env` file with `DATABASE_URL` and `PORT`

```bash
git clone https://github.com/nnnour/appointments_Agent
cd appointments_Agent
npm install
npm start
```

> **Note:** The AI agent prompt and voice configuration live in a Telnyx portal account and are not part of this repository. To fully replicate the agent you would need your own Telnyx account, AI Assistant configuration, and phone number.

### Testing MCP tools directly

```bash
# Test availability check
curl -X POST https://appointmentsagent-production.up.railway.app/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_available_slots","arguments":{"modality":"X-ray","date":"tomorrow","time_preference":"any"}}}'

# Test dynamic variables webhook
curl -X POST https://appointmentsagent-production.up.railway.app/api/webhook/dynamic-variables \
  -H "Content-Type: application/json" \
  -d '{"data":{"payload":{"telnyx_end_user_target":"+14156760572"}}}'
```
