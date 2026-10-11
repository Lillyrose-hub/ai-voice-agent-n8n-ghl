const fs = require('fs');
const path = require('path');
const outDir = path.join(__dirname, 'workflows');

const P = "$('Mock In').item.json.body.payload";
const e = (s) => '={{ ' + s + ' }}';
const schemaFromKeys = (value) => Object.keys(value).map(k => ({
  id: k, displayName: k, type: 'string', canBeUsedToMatch: true, display: true, required: false, defaultMatch: false,
}));

let nid = 0;
const uid = (p) => p + '_' + (++nid);

function webhook(name, pathSeg, x, y) {
  return { parameters: { httpMethod: 'POST', path: pathSeg, responseMode: 'responseNode', options: {} },
    id: uid('hook'), name, type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [x, y], webhookId: uid('wh') };
}
function code(name, jsCode, x, y) {
  return { parameters: { jsCode }, id: uid('code'), name, type: 'n8n-nodes-base.code', typeVersion: 2, position: [x, y] };
}
function respond(name, x, y) {
  return { parameters: { respondWith: 'firstIncomingItem', options: {} },
    id: uid('resp'), name, type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [x, y] };
}
function dtUpsert(name, table, matchCols, value, x, y) {
  return { parameters: {
      resource: 'row', operation: 'upsert',
      dataTableId: { __rl: true, mode: 'name', value: table },
      matchType: 'allConditions',
      filters: { conditions: matchCols.map(c => ({ keyName: c, condition: 'eq', keyValue: value[c] })) },
      columns: { mappingMode: 'defineBelow', value, schema: schemaFromKeys(value), matchingColumns: matchCols },
      options: {},
    }, id: uid('dt'), name, type: 'n8n-nodes-base.dataTable', typeVersion: 1.1, position: [x, y] };
}
function dtInsert(name, table, value, x, y) {
  return { parameters: {
      resource: 'row', operation: 'insert',
      dataTableId: { __rl: true, mode: 'name', value: table },
      columns: { mappingMode: 'defineBelow', value, schema: schemaFromKeys(value), matchingColumns: [] },
      options: {},
    }, id: uid('dt'), name, type: 'n8n-nodes-base.dataTable', typeVersion: 1.1, position: [x, y] };
}
function dtGet(name, table, conditions, x, y) {
  const params = { resource: 'row', operation: 'get',
    dataTableId: { __rl: true, mode: 'name', value: table }, returnAll: true };
  if (conditions && conditions.length) {
    params.matchType = 'allConditions';
    params.filters = { conditions: conditions.map(c => ({ keyName: c.col, condition: 'eq', keyValue: c.val })) };
  }
  return { parameters: params, id: uid('dt'), name, type: 'n8n-nodes-base.dataTable', typeVersion: 1.1,
    position: [x, y], alwaysOutputData: true };
}
function ifNode(name, leftExpr, x, y) {
  return { parameters: {
      conditions: { options: { caseSensitive: true, typeValidation: 'loose', version: 2 },
        conditions: [{ id: uid('c'), leftValue: leftExpr, rightValue: 0,
          operator: { type: 'number', operation: 'gt' } }], combinator: 'and' },
      options: {},
    }, id: uid('if'), name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [x, y] };
}

const nodes = [];
const connections = {};
function add(n) { nodes.push(n); return n; }
function link(from, to, fromOut = 0, toIn = 0) {
  connections[from.name] = connections[from.name] || { main: [] };
  while (connections[from.name].main.length <= fromOut) connections[from.name].main.push([]);
  connections[from.name].main[fromOut].push({ node: to.name, type: 'main', index: toIn });
}

// ----- trigger + router -----
const hook = add(webhook('Mock In', 'mock-ghl', -600, 0));
const route = add({ parameters: {
    mode: 'expression', numberOutputs: 11,
    output: e("({upsertContact:0,addNote:1,getFreeSlots:2,bookAppointment:3,createOpportunity:4,sendMessage:5,getLeadsToCall:6,setOutboundStatus:7,setOutboundStatusBulk:8,debugDump:9})[($json.body && $json.body.op) || $json.op] ?? 10"),
    options: {},
  }, id: uid('switch'), name: 'Route', type: 'n8n-nodes-base.switch', typeVersion: 3.3, position: [-380, 0] });
link(hook, route);
const resp = add(respond('Respond', 1500, 0));

const BX = 100, CX = 500, RX = 1100; // branch node x positions
let row = -800;
function nextRow() { row += 160; return row; }

// 0 upsertContact
{ const y = nextRow();
  const up = add(dtUpsert('Upsert Contact', 'ghl_contacts', ['phone'], {
    phone: e(P + '.phone'), firstName: e(P + ".firstName || ''"), lastName: e(P + ".lastName || ''"),
    email: e(P + ".email || ''"), intent: e(P + ".intent || ''"),
  }, BX, y));
  const fmt = add(code('Fmt Contact', "const r=items[0].json; return [{json:{contact:{...r,id:r.phone}}}];", CX, y));
  link(route, up, 0); link(up, fmt); link(fmt, resp);
}
// 1 addNote
{ const y = nextRow();
  const ins = add(dtInsert('Insert Note', 'ghl_notes', {
    contactId: e(P + '.contactId'), body: e(P + ".body || ''"),
  }, BX, y));
  const fmt = add(code('Fmt Note', "const r=items[0].json; return [{json:{note:{id:'note_'+r.id,contactId:r.contactId,body:r.body,createdAt:r.createdAt}}}];", CX, y));
  link(route, ins, 1); link(ins, fmt); link(fmt, resp);
}
// 2 getFreeSlots
{ const y = nextRow();
  const get = add(dtGet('Get Appts (cal)', 'ghl_appointments', [{ col: 'calendarId', val: e(P + ".calendarId || 'cal_default'") }], BX, y));
  const fmt = add(code('Fmt FreeSlots', [
    "const P = $('Mock In').item.json.body.payload || {};",
    "const calendarId = P.calendarId || 'cal_default';",
    "const date = P.date || (new Date().toISOString().slice(0,10));",
    "const rows = items.map(i=>i.json).filter(r=>r && r.slot);",
    "const booked = rows.filter(r => (r.slot||'').slice(0,10)===date && r.status!=='cancelled').map(r=>r.slot);",
    "const all = ['09:00','10:00','11:00','13:00','14:00','15:00','16:00'].map(t=>date+'T'+t+':00');",
    "return [{json:{calendarId,date,slots: all.filter(s=>!booked.includes(s))}}];",
  ].join('\n'), CX, y));
  link(route, get, 2); link(get, fmt); link(fmt, resp);
}
// 3 bookAppointment
{ const y = nextRow();
  const get = add(dtGet('Get Appt (slot)', 'ghl_appointments', [
    { col: 'calendarId', val: e(P + ".calendarId || 'cal_default'") }, { col: 'slot', val: e(P + '.slot') },
  ], BX, y));
  const iff = add(ifNode('Slot Taken?', e('$json.id || 0'), CX - 200, y));
  const taken = add(code('Fmt Taken', "const P=$('Mock In').item.json.body.payload; return [{json:{error:'slot_taken',slot:P.slot}}];", CX + 120, y - 60));
  const ins = add(dtInsert('Insert Appt', 'ghl_appointments', {
    calendarId: e(P + ".calendarId || 'cal_default'"), slot: e(P + '.slot'),
    contactId: e(P + ".contactId || ''"), status: 'booked',
  }, CX + 120, y + 70));
  const booked = add(code('Fmt Booked', "const r=items[0].json; return [{json:{appointment:{id:'appt_'+r.id,calendarId:r.calendarId,slot:r.slot,contactId:r.contactId,status:r.status}}}];", CX + 340, y + 70));
  link(route, get, 3); link(get, iff);
  link(iff, taken, 0); link(taken, resp);
  link(iff, ins, 1); link(ins, booked); link(booked, resp);
}
// 4 createOpportunity
{ const y = nextRow();
  const ins = add(dtInsert('Insert Opp', 'ghl_opportunities', {
    contactId: e(P + '.contactId'), pipelineId: e(P + ".pipelineId || 'pipe_default'"),
    stage: e(P + ".stage || 'new'"), oppName: e(P + ".name || ''"),
  }, BX, y));
  const fmt = add(code('Fmt Opp', "const r=items[0].json; return [{json:{opportunity:{id:'opp_'+r.id,contactId:r.contactId,pipelineId:r.pipelineId,stage:r.stage,name:r.oppName,createdAt:r.createdAt}}}];", CX, y));
  link(route, ins, 4); link(ins, fmt); link(fmt, resp);
}
// 5 sendMessage
{ const y = nextRow();
  const ins = add(dtInsert('Insert Msg', 'ghl_messages', {
    contactId: e(P + '.contactId'), channel: e(P + ".channel || 'sms'"),
    message: e(P + ".message || ''"), status: 'sent', sentAt: e('$now.toISO()'),
  }, BX, y));
  const fmt = add(code('Fmt Msg', "const r=items[0].json; return [{json:{message:{id:'msg_'+r.id,contactId:r.contactId,channel:r.channel,message:r.message,status:r.status,sentAt:r.sentAt}}}];", CX, y));
  link(route, ins, 5); link(ins, fmt); link(fmt, resp);
}
// 6 getLeadsToCall
{ const y = nextRow();
  const get = add(dtGet('Get Queued', 'ghl_contacts', [{ col: 'outboundStatus', val: 'queued' }], BX, y));
  const fmt = add(code('Fmt Leads', [
    "const rows = items.map(i=>i.json).filter(r=>r && r.phone && r.outboundStatus==='queued');",
    "return [{json:{leads: rows.map(r=>({id:r.phone,firstName:r.firstName||'',lastName:r.lastName||'',phone:r.phone,intent:r.intent||'',outboundStatus:r.outboundStatus}))}}];",
  ].join('\n'), CX, y));
  link(route, get, 6); link(get, fmt); link(fmt, resp);
}
// 7 setOutboundStatus
{ const y = nextRow();
  const up = add(dtUpsert('Set Outbound', 'ghl_contacts', ['phone'], {
    phone: e(P + '.contactId'), outboundStatus: e(P + '.status'), lastCallId: e(P + ".callId || ''"),
  }, BX, y));
  const fmt = add(code('Fmt SetOut', "const r=items[0].json; return [{json:{contact:{...r,id:r.phone}}}];", CX, y));
  link(route, up, 7); link(up, fmt); link(fmt, resp);
}
// 8 setOutboundStatusBulk
{ const y = nextRow();
  const split = add(code('Split Updates', "const ups=($('Mock In').item.json.body.payload.updates)||[]; return ups.map(u=>({json:u}));", BX, y));
  const up = add(dtUpsert('Bulk Set', 'ghl_contacts', ['phone'], {
    phone: e('$json.contactId'), outboundStatus: e('$json.status'), lastCallId: e("$json.callId || ''"),
  }, CX, y));
  const agg = add(code('Fmt Bulk', "return [{json:{updated: items.map(i=>i.json.phone)}}];", RX, y));
  link(route, split, 8); link(split, up); link(up, agg); link(agg, resp);
}
// 9 debugDump
{ const y = nextRow();
  const get = add(dtGet('Dump Contacts', 'ghl_contacts', [], BX, y));
  const fmt = add(code('Fmt Dump', [
    "const rows = items.map(i=>i.json).filter(r=>r && r.phone);",
    "const contacts = {}; rows.forEach(r=>{ contacts[r.phone] = { id:r.phone, ...r }; });",
    "return [{json:{store:{contacts}}}];",
  ].join('\n'), CX, y));
  link(route, get, 9); link(get, fmt); link(fmt, resp);
}
// 10 unknown
{ const y = nextRow();
  const fmt = add(code('Fmt Unknown', "return [{json:{error:'unknown_op', op: ($('Mock In').item.json.body||{}).op || null}}];", BX, y));
  link(route, fmt, 10); link(fmt, resp);
}

const wfd = { id: 'WFDmockGHLapi001', name: 'WF-D Mock GHL API',
  nodes, connections, active: true, settings: { executionOrder: 'v1' }, pinData: {} };

// ----- WF-F: setup tables -----
let fnid = 0; const fuid = (p) => 'f_' + p + '_' + (++fnid);
function tableCreate(name, table, cols, x) {
  return { parameters: {
      resource: 'table', operation: 'create', tableName: table,
      columns: { column: cols.map(c => ({ name: c, type: 'string' })) },
      options: { createIfNotExists: true },
    }, id: fuid('ct'), name, type: 'n8n-nodes-base.dataTable', typeVersion: 1.1, position: [x, 0] };
}
const fHook = { parameters: { httpMethod: 'POST', path: 'setup-tables', responseMode: 'lastNode', options: {} },
  id: fuid('hook'), name: 'Setup In', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [-600, 0], webhookId: fuid('wh') };
const fTables = [
  ['Create contacts', 'ghl_contacts', ['phone', 'firstName', 'lastName', 'email', 'intent', 'outboundStatus', 'lastCallId']],
  ['Create notes', 'ghl_notes', ['contactId', 'body']],
  ['Create appointments', 'ghl_appointments', ['calendarId', 'slot', 'contactId', 'status']],
  ['Create opportunities', 'ghl_opportunities', ['contactId', 'pipelineId', 'stage', 'oppName']],
  ['Create messages', 'ghl_messages', ['contactId', 'channel', 'message', 'status', 'sentAt']],
];
const fNodes = [fHook];
const fConns = {};
let prev = fHook; let fx = -380;
for (const [nm, tbl, cols] of fTables) {
  const n = tableCreate(nm, tbl, cols, fx); fx += 220; fNodes.push(n);
  fConns[prev.name] = { main: [[{ node: n.name, type: 'main', index: 0 }]] }; prev = n;
}
const wff = { id: 'WFFsetupTbls001', name: 'WF-F Setup Data Tables',
  nodes: fNodes, connections: fConns, active: true, settings: { executionOrder: 'v1' }, pinData: {} };

fs.writeFileSync(path.join(outDir, 'wf-d-mock-ghl.json'), JSON.stringify(wfd, null, 2));
fs.writeFileSync(path.join(outDir, 'wf-f-setup-tables.json'), JSON.stringify(wff, null, 2));
console.log('wrote wf-d-mock-ghl.json (' + nodes.length + ' nodes) and wf-f-setup-tables.json');
