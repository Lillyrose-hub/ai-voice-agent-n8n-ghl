const fs = require('fs');
const path = require('path');
const outDir = path.join(__dirname, 'workflows');

function webhook(id, name, pathSeg, x, responseMode = 'lastNode') {
  return {
    parameters: { httpMethod: 'POST', path: pathSeg, responseMode, options: {} },
    id, name, type: 'n8n-nodes-base.webhook', typeVersion: 2,
    position: [x, 0], webhookId: id,
  };
}
function code(id, name, jsCode, x) {
  return {
    parameters: { jsCode },
    id, name, type: 'n8n-nodes-base.code', typeVersion: 2, position: [x, 0],
  };
}
function callSub(id, name, x) {
  return {
    parameters: {
      workflowId: { __rl: true, value: 'SUBghlClient0001', mode: 'id', cachedResultName: 'SUB GHL Client' },
      options: {},
    },
    id, name, type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.2, position: [x, 0],
  };
}
function http(id, name, url, x) {
  return {
    parameters: {
      method: 'POST', url,
      sendBody: true, specifyBody: 'json', jsonBody: '={{ $json.vapiPayload }}',
      options: {},
    },
    id, name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [x, 0],
  };
}
function chain(nodes) {
  const c = {};
  for (let i = 0; i < nodes.length - 1; i++) {
    c[nodes[i].name] = { main: [[{ node: nodes[i + 1].name, type: 'main', index: 0 }]] };
  }
  return c;
}

// ---------- WF-A: Vapi Tools (mid-call) ----------
const mapTool = `
const b = items[0].json.body || items[0].json || {};
const msg = b.message || {};
const caller = (msg.call && msg.call.customer && msg.call.customer.number) || (msg.customer && msg.customer.number) || null;
let name, args = {}, toolCallId = null;
if (Array.isArray(msg.toolCalls) && msg.toolCalls.length) {
  const tc = msg.toolCalls[0];
  toolCallId = tc.id;
  name = tc.function && tc.function.name;
  args = (tc.function && tc.function.arguments) || {};
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch (e) { args = {}; } }
} else if (msg.functionCall) {
  name = msg.functionCall.name;
  args = msg.functionCall.parameters || {};
  toolCallId = msg.functionCall.id || 'legacy';
}
let op = null, payload = {};
if (name === 'checkAvailability') { op = 'getFreeSlots'; payload = { calendarId: args.calendarId || 'cal_default', date: args.date }; }
else if (name === 'bookAppointment') { const slot = args.slot || (args.date && args.time ? (args.date + 'T' + args.time + ':00') : null); op = 'bookAppointment'; payload = { calendarId: args.calendarId || 'cal_default', slot: slot, contactId: args.contactId || caller || null }; }
return [{ json: { toolCallId, toolName: name || null, op, payload } }];
`.trim();

const formatResult = `
const m = $('Map Tool').first().json;
const data = items[0].json || {};
let result;
if (m.toolName === 'checkAvailability') {
  const slots = data.slots || [];
  result = slots.length ? ('Available times: ' + slots.map(s => s.slice(11, 16)).join(', ')) : 'No open times that day.';
} else if (m.toolName === 'bookAppointment') {
  if (data.appointment) result = 'Booked for ' + data.appointment.slot.slice(0, 16).replace('T', ' at ') + '.';
  else if (data.error === 'slot_taken') result = 'Sorry, that time was just taken.';
  else result = 'I could not book that.';
} else {
  result = 'Sorry, I did not understand that request.';
}
return [{ json: { results: [{ toolCallId: m.toolCallId, result }] } }];
`.trim();

const wfaNodes = [
  webhook('wfa_hook', 'Vapi Tools In', 'vapi-tools', -300),
  code('wfa_map', 'Map Tool', mapTool, -80),
  callSub('wfa_sub', 'Call SUB', 140),
  code('wfa_fmt', 'Format Result', formatResult, 360),
];
const wfa = {
  id: 'WFAvapiTools001', name: 'WF-A Vapi Tools (mid-call)',
  nodes: wfaNodes, connections: chain(wfaNodes),
  active: true, settings: { executionOrder: 'v1' }, pinData: {},
};

// ---------- WF-B: End-of-call sync ----------
const extract = `
const b = items[0].json.body || items[0].json || {};
const msg = b.message || {};
if (msg.type && msg.type !== 'end-of-call-report') { return []; }
const sd = (msg.analysis && msg.analysis.structuredData) || {};
const phone = (msg.customer && msg.customer.number) || sd.phone || '';
return [{ json: {
  phone,
  firstName: sd.firstName || '',
  lastName: sd.lastName || '',
  email: sd.email || '',
  transcript: msg.transcript || '',
  summary: msg.summary || '',
  intent: sd.intent || ''
} }];
`.trim();

const prepUpsert = `
const e = $('Extract Call Data').first().json;
return [{ json: { op: 'upsertContact', payload: { firstName: e.firstName, lastName: e.lastName, phone: e.phone, email: e.email } } }];
`.trim();

const prepNote = `
const e = $('Extract Call Data').first().json;
const c = $('Upsert Contact').first().json;
const id = c.contact && c.contact.id;
const body = 'Call summary: ' + (e.summary || '(none)') + '\\n\\nTranscript:\\n' + (e.transcript || '(none)');
return [{ json: { op: 'addNote', payload: { contactId: id, body } } }];
`.trim();

const prepOpp = `
const e = $('Extract Call Data').first().json;
const c = $('Upsert Contact').first().json;
const id = c.contact && c.contact.id;
const nm = ((e.firstName || '') + ' ' + (e.lastName || '')).trim() || 'Inbound caller';
return [{ json: { op: 'createOpportunity', payload: { contactId: id, name: nm + ' - ' + (e.intent || 'inquiry'), stage: 'new' } } }];
`.trim();

const prepMsg = `
const c = $('Upsert Contact').first().json;
const id = c.contact && c.contact.id;
return [{ json: { op: 'sendMessage', payload: { contactId: id, channel: 'sms', message: 'Thanks for calling! We logged your request and will follow up shortly.' } } }];
`.trim();

const summary = `
const c = $('Upsert Contact').first().json;
return [{ json: { status: 'ok', contactId: (c.contact && c.contact.id) || null } }];
`.trim();

const wfbNodes = [
  webhook('wfb_hook', 'Vapi EOC In', 'vapi-eoc', -520, 'onReceived'),
  code('wfb_extract', 'Extract Call Data', extract, -300),
  code('wfb_pu', 'Prep Upsert', prepUpsert, -80),
  callSub('wfb_upsert', 'Upsert Contact', 140),
  code('wfb_pn', 'Prep Note', prepNote, 360),
  callSub('wfb_note', 'Add Note', 580),
  code('wfb_po', 'Prep Opportunity', prepOpp, 800),
  callSub('wfb_opp', 'Create Opportunity', 1020),
  code('wfb_pm', 'Prep Message', prepMsg, 1240),
  callSub('wfb_msg', 'Send Message', 1460),
  code('wfb_sum', 'Done', summary, 1680),
];
const wfb = {
  id: 'WFBendOfCall001', name: 'WF-B End-of-call Sync',
  nodes: wfbNodes, connections: chain(wfbNodes),
  active: true, settings: { executionOrder: 'v1' }, pinData: {},
};

// ---------- WF-E: Mock Vapi API ----------
const vapiMock = `
const b = items[0].json.body || items[0].json || {};
const id = 'vapi_call_' + Math.random().toString(36).slice(2, 10);
return [{ json: { id, status: 'queued', echo: { customer: b.customer || null, phoneNumberId: b.phoneNumberId || null } } }];
`.trim();

const wfeNodes = [
  webhook('wfe_hook', 'Mock Vapi In', 'mock-vapi-call', -120),
  code('wfe_create', 'Create Call', vapiMock, 100),
];
const wfe = {
  id: 'WFEmockVapi00001', name: 'WF-E Mock Vapi API',
  nodes: wfeNodes, connections: chain(wfeNodes),
  active: true, settings: { executionOrder: 'v1' }, pinData: {},
};

// ---------- WF-C: Outbound ----------
const prepGetLeads = `return [{ json: { op: 'getLeadsToCall', payload: {} } }];`;

const splitLeads = `
const leads = (items[0].json && items[0].json.leads) || [];
return leads.map(l => ({ json: l }));
`.trim();

const buildVapiCall = `
const toolsUrl = 'http://localhost:5678/webhook/vapi-tools';
const eocUrl = 'http://localhost:5678/webhook/vapi-eoc';
return items.map(it => {
  const lead = it.json;
  const vapiPayload = {
    phoneNumberId: 'REPLACE_WITH_VAPI_NUMBER_ID',
    assistantId: 'REPLACE_WITH_VAPI_ASSISTANT_ID',
    customer: { number: lead.phone },
    assistantOverrides: {
      serverUrl: eocUrl,
      variableValues: { firstName: lead.firstName || '', intent: lead.intent || 'follow-up' }
    },
    metadata: { contactId: lead.id, toolsUrl }
  };
  return { json: { contactId: lead.id, phone: lead.phone, vapiPayload } };
});
`.trim();

// Batch all marks into ONE mock write to avoid static-data read-modify-write races.
const prepMark = `
const builds = $('Build Vapi Call').all();
const updates = items.map((it, i) => ({
  contactId: builds[i].json.contactId,
  status: 'call_initiated',
  callId: it.json.id || null
}));
return [{ json: { op: 'setOutboundStatusBulk', payload: { updates } } }];
`.trim();

const outboundDone = `return [{ json: { status: 'ok', calls_initiated: $('Build Vapi Call').all().length } }];`;

const wfcNodes = [
  webhook('wfc_hook', 'Run Outbound', 'run-outbound', -820),
  code('wfc_pg', 'Prep Get Leads', prepGetLeads, -600),
  callSub('wfc_get', 'Get Leads', -380),
  code('wfc_split', 'Split Leads', splitLeads, -160),
  code('wfc_build', 'Build Vapi Call', buildVapiCall, 60),
  http('wfc_call', 'Place Call (Mock Vapi)', 'http://localhost:5678/webhook/mock-vapi-call', 280),
  code('wfc_mark', 'Prep Mark Called', prepMark, 500),
  callSub('wfc_set', 'Mark Called', 720),
  code('wfc_done', 'Summarize', outboundDone, 940),
];
const wfc = {
  id: 'WFCoutbound00001', name: 'WF-C Outbound',
  nodes: wfcNodes, connections: chain(wfcNodes),
  active: true, settings: { executionOrder: 'v1' }, pinData: {},
};

fs.writeFileSync(path.join(outDir, 'wf-a-vapi-tools.json'), JSON.stringify(wfa, null, 2));
fs.writeFileSync(path.join(outDir, 'wf-b-end-of-call.json'), JSON.stringify(wfb, null, 2));
fs.writeFileSync(path.join(outDir, 'wf-e-mock-vapi.json'), JSON.stringify(wfe, null, 2));
fs.writeFileSync(path.join(outDir, 'wf-c-outbound.json'), JSON.stringify(wfc, null, 2));
console.log('wrote wf-a, wf-b, wf-e, wf-c');
