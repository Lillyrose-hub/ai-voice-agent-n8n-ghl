# AI Voice Agent → n8n → GoHighLevel

A portfolio project that integrates an **AI voice agent (Vapi)** with **GoHighLevel (GHL)** using **n8n** as the orchestration layer. It is built **mock-first**: the entire inbound + outbound call workflow runs end to end on a local n8n instance with **no paid subscriptions and no access to any real client account**.

The GHL side is simulated by a local mock API backed by **n8n Data Tables**, so every read and write is a per-row atomic database operation — the mock survives concurrent calls without losing data. When you are ready to go live, a single swap-point workflow repoints the whole system at the real GHL API.

---

## Highlights

- **Zero budget / fully local** — runs on a self-hosted n8n with nothing but Node.js installed.
- **Mock-first** — develop and test the complete flow before creating any external account.
- **Concurrency-safe mock** — storage moved from n8n static data to Data Tables; verified that 8 simultaneous writes all persist (static data dropped some).
- **One swap-point** — every GHL call goes through a single sub-workflow, so switching mock → real GHL is a one-line change.
- **Inbound + outbound** — real-time mid-call tools, post-call CRM sync, and outbound call initiation.

---

## Architecture

```
            INBOUND                                    OUTBOUND
   Caller --> Vapi agent                     WF-C trigger --> Vapi API (create call)
               |  (STT + OpenAI + TTS)                         |
     mid-call  | tool call                        Vapi dials lead, runs script
               v                                                |
        +------------------  n8n (localhost:5678)  ------------------+
        |  WF-A  Vapi tools webhook    (real-time: check slots, book) |
        |  WF-B  Vapi end-of-call webhook (post-call CRM sync)        |
        |  WF-C  Outbound trigger (pull leads -> place calls)         |
        |  SUB   GHL client sub-workflow  <-- single swap point       |
        |  WF-D  Mock GHL API (n8n Data Tables, atomic rows)          |
        |  WF-E  Mock Vapi API (fake call IDs for local testing)      |
        |  WF-F  Setup Data Tables (idempotent table creation)        |
        +-------------------------------------------------------------+
                              | HTTP (base URL = mock today, real GHL later)
                              v
                   Data Tables  -->-->  (later) real GoHighLevel API
```

---

## Workflows

| File | Workflow | Webhook | Purpose |
|------|----------|---------|---------|
| `workflows/wf-a-vapi-tools.json` | WF-A Vapi Tools (mid-call) | `POST /webhook/vapi-tools` | Handles Vapi tool calls (`checkAvailability`, `bookAppointment`) during a live call and returns a spoken result. |
| `workflows/wf-b-end-of-call.json` | WF-B End-of-call Sync | `POST /webhook/vapi-eoc` | On call end: upsert contact, log transcript as a note, create opportunity, send follow-up message. |
| `workflows/wf-c-outbound.json` | WF-C Outbound | `POST /webhook/run-outbound` | Pulls queued leads, builds a Vapi call payload per lead, places the call, and bulk-marks them `call_initiated`. (Swap trigger to a Schedule in production.) |
| `workflows/sub-ghl-client.json` | SUB GHL Client | (called by others) | The only component that talks to GHL. `baseUrl` in one node is the swap point. |
| `workflows/wf-d-mock-ghl.json` | WF-D Mock GHL API | `POST /webhook/mock-ghl` | Data-Table-backed mock of the GHL endpoints the system needs. |
| `workflows/wf-e-mock-vapi.json` | WF-E Mock Vapi API | `POST /webhook/mock-vapi-call` | Returns a fake call ID so WF-C runs without a real Vapi account. |
| `workflows/wf-f-setup-tables.json` | WF-F Setup Data Tables | `POST /webhook/setup-tables` | Creates the five Data Tables idempotently (`createIfNotExists`). |

> `workflows/zz-probe-datatable.json` is a throwaway used to validate the Data Table node; safe to delete.

---

## Mock GHL API (operations)

All requests are `POST /webhook/mock-ghl` with a body of `{ "op": "<name>", "payload": { ... } }`.
Contacts are keyed by phone, so **`contact.id` is the phone number**.

| op | payload | returns |
|----|---------|---------|
| `upsertContact` | `firstName, lastName, phone, email, intent` | `{ contact }` |
| `addNote` | `contactId, body` | `{ note }` |
| `getFreeSlots` | `calendarId, date` | `{ slots: [...] }` |
| `bookAppointment` | `calendarId, slot, contactId` | `{ appointment }` or `{ error: "slot_taken" }` |
| `createOpportunity` | `contactId, name, stage, pipelineId` | `{ opportunity }` |
| `sendMessage` | `contactId, channel, message` | `{ message }` |
| `getLeadsToCall` | — | `{ leads: [...] }` (contacts with `outboundStatus = queued`) |
| `setOutboundStatus` | `contactId, status, callId` | `{ contact }` |
| `setOutboundStatusBulk` | `updates: [{ contactId, status, callId }]` | `{ updated: [...] }` |
| `debugDump` | — | `{ store: { contacts } }` |

### Data Tables

Created by WF-F: `ghl_contacts`, `ghl_notes`, `ghl_appointments`, `ghl_opportunities`, `ghl_messages`.

> Note: n8n Data Tables auto-add `id`, `createdAt`, `updatedAt` system columns — user columns must not reuse those names.

---

## Run it locally

### Prerequisites
- Node.js (tested on v26) and a global install of n8n (`npm install -g n8n`).

### 1. Start n8n
```bash
n8n start
# editor at http://localhost:5678
```

### 2. Import the workflows
Either via the editor (**... menu -> Import from File**) for each file in `workflows/`, or via the CLI:
```bash
for f in workflows/*.json; do n8n import:workflow --input="$f"; done
```
Activate the webhook workflows (WF-A, WF-B, WF-C, WF-D, WF-E, WF-F) and publish SUB, then restart n8n so the webhooks register.

### 3. Create the Data Tables
```bash
curl -X POST http://localhost:5678/webhook/setup-tables -H 'Content-Type: application/json' -d '{}'
```

### 4. Try the mock
```bash
# free slots
curl -s -X POST http://localhost:5678/webhook/mock-ghl \
  -H 'Content-Type: application/json' \
  -d '{"op":"getFreeSlots","payload":{"calendarId":"cal_default","date":"2026-10-25"}}'

# book one, then re-check (the slot is now gone)
curl -s -X POST http://localhost:5678/webhook/mock-ghl \
  -H 'Content-Type: application/json' \
  -d '{"op":"bookAppointment","payload":{"calendarId":"cal_default","slot":"2026-10-25T10:00:00","contactId":"+15551234567"}}'
```

### 5. Exercise the voice-agent flows
```bash
# mid-call tool: check availability (Vapi tool-call shape in, Vapi results shape out)
curl -s -X POST http://localhost:5678/webhook/vapi-tools \
  -H 'Content-Type: application/json' \
  -d '{"message":{"type":"tool-calls","toolCalls":[{"id":"call_1","function":{"name":"checkAvailability","arguments":{"date":"2026-10-25"}}}]}}'

# end-of-call CRM sync
curl -s -X POST http://localhost:5678/webhook/vapi-eoc \
  -H 'Content-Type: application/json' \
  -d '{"message":{"type":"end-of-call-report","summary":"wants a trial","transcript":"...","customer":{"number":"+15559998888"},"analysis":{"structuredData":{"firstName":"Sam","lastName":"Rivera","intent":"trial"}}}}'

# outbound: queue a lead, then run the outbound workflow
curl -s -X POST http://localhost:5678/webhook/mock-ghl -H 'Content-Type: application/json' \
  -d '{"op":"setOutboundStatus","payload":{"contactId":"+15551110001","status":"queued"}}'
curl -s -X POST http://localhost:5678/webhook/run-outbound -H 'Content-Type: application/json' -d '{}'
```

---

## Regenerating the workflows

The larger workflows are generated by Node builder scripts so the embedded code stays readable (no hand-escaped JSON):

```bash
node build_workflows.js        # WF-A, WF-B, WF-C, WF-E
node build_mock_datatable.js   # WF-D (Data-Table mock) + WF-F (table setup)
```

Edit the builder, re-run it, then re-import the affected workflow.

---

## Going live

1. **Vapi** — create an assistant with two tools (`checkAvailability`, `bookAppointment`) whose server URL is your `vapi-tools` webhook, and set the end-of-call webhook to `vapi-eoc`. Add your OpenAI key in Vapi. Fill the `REPLACE_WITH_VAPI_*` placeholders in WF-C.
2. **Tunnel** — expose local n8n so Vapi can reach it (`n8n start --tunnel`, or a free Cloudflare tunnel).
3. **Real GHL** — change `baseUrl` in **SUB GHL Client** to the GHL API base and map the mock ops to GHL v2 endpoints (contacts upsert, calendars free-slots, appointments, opportunities, conversations messages). Nothing else changes.

---

## Repository layout

```
.
├── build_workflows.js         # generates WF-A, WF-B, WF-C, WF-E
├── build_mock_datatable.js    # generates WF-D (Data Table mock) + WF-F
└── workflows/                 # importable n8n workflow JSON
```

## Tech

n8n (self-hosted) · Vapi (voice) · OpenAI (LLM) · GoHighLevel (CRM) · Node.js
