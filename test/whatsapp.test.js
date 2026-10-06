'use strict';
// Tests hors-ligne du module WhatsApp (Node 22+ : node --test test/)
// Utilise node:sqlite en mémoire et un faux fetch : aucun appel réseau réel.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const wa = require('../whatsapp');

const PHONE_ID = '1370755836117468';
const tick = () => new Promise((r) => setTimeout(r, 25));

function makeDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, balance INTEGER);
          CREATE TABLE reports (case_id TEXT, category TEXT, user_id INTEGER, created_at INTEGER);`);
  return {
    raw: d,
    async execute(q) {
      const sql = typeof q === 'string' ? q : q.sql;
      const args = typeof q === 'string' ? [] : (q.args || []);
      const st = d.prepare(sql);
      if (/^\s*(select|pragma|with)/i.test(sql)) return { rows: st.all(...args), rowsAffected: 0 };
      return { rows: [], rowsAffected: Number(st.run(...args).changes) };
    },
  };
}
function fakeApp() {
  const routes = [];
  const reg = (method) => (path, ...handlers) => routes.push({ method, path, handlers });
  return { routes, get: reg('get'), post: reg('post'), find: (m, p) => routes.find((r) => r.method === m && r.path === p) };
}
async function call(app, method, path, { body, query, headers = {}, params, rawBody } = {}) {
  const r = app.find(method, path);
  assert.ok(r, `route absente : ${method} ${path}`);
  const req = { body, query: query || {}, params: params || {}, path, rawBody, get: (h) => headers[h.toLowerCase()], header: (h) => headers[h.toLowerCase()] };
  const res = {
    statusCode: 200, headersSent: false, headers: {}, payload: undefined,
    status(c) { this.statusCode = c; return this; }, set(o) { Object.assign(this.headers, o); return this; },
    type(t) { this.headers['content-type'] = t; return this; },
    json(o) { this.payload = o; this.headersSent = true; return this; },
    send(x) { this.payload = x; this.headersSent = true; return this; },
    sendStatus(c) { this.statusCode = c; this.headersSent = true; return this; },
  };
  for (const h of r.handlers) { let next = false; await h(req, res, () => { next = true; }); if (!next) break; }
  return res;
}

let calls = [];
let seq = 0;
function mockFetch(over) {
  global.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body;
    const rec = { path: u.pathname, method: opts.method || 'GET', body, query: Object.fromEntries(u.searchParams) };
    calls.push(rec);
    let out = over && (await over(rec));
    if (!out) {
      if (rec.method === 'POST' && rec.path.endsWith('/messages')) out = { json: { messaging_product: 'whatsapp', messages: [{ id: `wamid.OUT${++seq}` }] } };
      else out = { json: { id: '123', status: 'PENDING' } };
    }
    const status = out.status || 200;
    return { ok: status < 400, status, json: async () => out.json || {}, arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => null } };
  };
}
const outMessages = () => calls.filter((c) => c.method === 'POST' && c.path.endsWith(`/${PHONE_ID}/messages`) && c.body.status !== 'read').map((c) => c.body);

async function setup({ env: extra = {}, user = { id: 7 } } = {}) {
  calls = []; mockFetch();
  const db = makeDb(); const app = fakeApp();
  const pass = (_q, _s, n) => n();
  const e = (k, d) => (k in extra ? extra[k] : d);
  const mod = wa.create({ app, db, env: e, getUserFromToken: async () => user, adminAuth: pass, requireAdminXhr: pass, limitAdmin: pass, rateLimit: () => pass });
  await mod.ready();
  await db.execute({ sql: 'INSERT INTO users (id, email, balance) VALUES (7, ?, 8000)', args: ['jean@gmail.com'] });
  return { db, app, mod };
}
const inbound = (from, text, id = `wamid.IN${++seq}`, extra = {}) => ({ entry: [{ changes: [{ field: 'messages', value: { contacts: [{ wa_id: from, profile: { name: 'Client' } }], messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text }, ...extra }] } }] }] });

test('constructeurs : validations', () => {
  assert.equal(wa.buildMessage({ type: 'text', text: 'Salut' }).text.body, 'Salut');
  assert.throws(() => wa.buildMessage({ type: 'text', text: 'x'.repeat(4097) }), /4096/);
  assert.throws(() => wa.buildMessage({ type: 'buttons', body: 'b', buttons: [1, 2, 3, 4].map((n) => ({ id: `${n}`, title: `B${n}` })) }), /1 à 3/);
  assert.throws(() => wa.buildMessage({ type: 'list', body: 'b', sections: [{ rows: Array.from({ length: 11 }, (_, i) => ({ id: `${i}`, title: `R${i}` })) }] }), /10 lignes/);
  assert.throws(() => wa.buildMessage({ type: 'image', link: 'http://x/y.png' }), /https/);
  assert.throws(() => wa.buildMessage({ type: 'cta_url', body: 'b', text: 'Go', url: 'http://x' }), /https/);
  assert.throws(() => wa.buildMessage({ type: 'location', latitude: 120, longitude: 1 }), /Latitude/);
  assert.throws(() => wa.buildMessage({ type: 'template', name: 'Mauvais Nom' }), /Nom de modèle/);
  const t = wa.buildMessage({ type: 'template', name: 'hello_world', lang: 'en_US', params: ['a\nb'], buttons: [{ sub_type: 'url', param: 'x' }], reply_to: 'wamid.X' });
  assert.equal(t.template.components[0].parameters[0].text, 'a b');
  assert.equal(t.context.message_id, 'wamid.X');
  assert.equal(wa.buildMessage({ type: 'reaction', message_id: 'wamid.Y', emoji: '👍' }).reaction.emoji, '👍');
  assert.equal(wa.buildMessage({ type: 'interactive_dummy' === 'x' ? 'x' : 'flow', body: 'b', cta: 'Ouvrir', flow_id: '1', screen: 'S' }).interactive.action.parameters.flow_id, '1');
  assert.equal(wa.buildMessage({ type: 'contacts', contacts: [{ name: 'Ana Bo', phone: '+237 600 000 000' }] }).contacts[0].phones[0].phone, '+237600000000');
  assert.equal(wa.buildMessage({ type: 'product', catalog_id: 'c', product_id: 'p' }).interactive.type, 'product');
});

test('webhook : vérification GET', async () => {
  const { app } = await setup();
  const ok = await call(app, 'get', '/webhook/whatsapp', { query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'takamura_verif_2026', 'hub.challenge': '123' } });
  assert.equal(ok.statusCode, 200); assert.equal(ok.payload, '123');
  const ko = await call(app, 'get', '/webhook/whatsapp', { query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'faux', 'hub.challenge': '123' } });
  assert.equal(ko.statusCode, 403);
});

test('webhook : signature POST (WHATSAPP_APP_SECRET)', async () => {
  const { app } = await setup({ env: { WHATSAPP_APP_SECRET: 's3cret' } });
  const raw = Buffer.from(JSON.stringify({ entry: [] }));
  const good = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(raw).digest('hex');
  assert.equal((await call(app, 'post', '/webhook/whatsapp', { body: { entry: [] }, rawBody: raw, headers: { 'x-hub-signature-256': 'sha256=00' } })).statusCode, 403);
  assert.equal((await call(app, 'post', '/webhook/whatsapp', { body: { entry: [] }, rawBody: raw, headers: { 'x-hub-signature-256': good } })).statusCode, 200);
});

test('message entrant : stockage, lecture, menu, anti-doublon', async () => {
  const { db, mod } = await setup();
  const payload = inbound('237600000001', 'salut', 'wamid.IN-A');
  await mod.handleWebhook(payload); await tick();
  const c = (await db.execute(`SELECT * FROM wa_contacts WHERE wa_id = '237600000001'`)).rows[0];
  assert.equal(c.name, 'Client'); assert.ok(c.last_inbound_at);
  assert.equal((await db.execute(`SELECT COUNT(*) AS n FROM wa_messages WHERE direction = 'in'`)).rows[0].n, 1);
  const read = calls.find((x) => x.body && x.body.status === 'read');
  assert.equal(read.body.message_id, 'wamid.IN-A'); assert.deepEqual(read.body.typing_indicator, { type: 'text' });
  const menu = outMessages().find((m) => m.type === 'interactive');
  assert.equal(menu.to, '237600000001'); assert.equal(menu.interactive.type, 'list');
  const before = calls.length;
  await mod.handleWebhook(payload); await tick();
  assert.equal(calls.length, before, 'un doublon ne doit rien renvoyer');
});

test('liaison du compte par code + SOLDE + HISTORIQUE', async () => {
  const { db, app, mod } = await setup();
  const r = await call(app, 'post', '/api/wa/link-code');
  assert.equal(r.statusCode, 200);
  const { code, link } = r.payload;
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/); assert.ok(link.includes('wa.me/15556484842?text=TAKAMURA'));
  await mod.handleWebhook(inbound('237600000002', `Bonjour TAKAMURA ${code}`)); await tick();
  const c = (await db.execute(`SELECT * FROM wa_contacts WHERE wa_id = '237600000002'`)).rows[0];
  assert.equal(c.user_id, 7); assert.equal(c.opted_in, 1); assert.equal(c.consent_source, 'whatsapp:link');
  assert.ok(outMessages().some((m) => m.type === 'text' && m.text.body.includes('je***@gmail.com')));
  assert.equal((await db.execute('SELECT COUNT(*) AS n FROM wa_link_codes')).rows[0].n, 0, 'code à usage unique');
  await db.execute({ sql: `INSERT INTO reports VALUES ('TKM-1', 'Spam', 7, ?)`, args: [Date.now()] });
  await mod.handleWebhook(inbound('237600000002', 'solde')); await tick();
  assert.ok(outMessages().some((m) => m.type === 'text' && /8 000 FCFA/.test(m.text.body)));
  await mod.handleWebhook(inbound('237600000002', 'Historique')); await tick();
  assert.ok(outMessages().some((m) => m.type === 'text' && m.text.body.includes('TKM-1')));
  const st = await call(app, 'get', '/api/wa/status');
  assert.equal(st.payload.linked, true);
  await call(app, 'post', '/api/wa/unlink');
  assert.equal((await call(app, 'get', '/api/wa/status')).payload.linked, false);
});

test('STOP : désinscription et plus aucun envoi', async () => {
  const { mod } = await setup();
  await mod.handleWebhook(inbound('237600000003', 'salut')); await tick();
  await mod.handleWebhook(inbound('237600000003', 'STOP')); await tick();
  assert.ok(outMessages().some((m) => m.type === 'text' && /plus de messages/.test(m.text.body)), 'confirmation de désinscription envoyée');
  const n = outMessages().length;
  await assert.rejects(mod.sendText('237600000003', 'test'), (e) => e.code === 'opted_out');
  await mod.handleWebhook(inbound('237600000003', 'menu')); await tick();
  assert.equal(outMessages().length, n, 'aucune réponse automatique après STOP');
});

test('règles : fenêtre 24 h et consentement', async () => {
  const { app, mod } = await setup();
  await assert.rejects(mod.sendText('237600000004', 'hello'), (e) => e.code === 'window_closed');
  await assert.rejects(mod.sendTemplate('237600000004', 'hello_world', 'en_US'), (e) => e.code === 'no_consent');
  const r = await call(app, 'post', '/admin/wa/api/consent', { body: { wa_id: '237600000004', attest: true, note: 'oral' } });
  assert.equal(r.payload.ok, true);
  assert.equal((await mod.sendTemplate('237600000004', 'hello_world', 'en_US')).status, 'accepted');
  const noAttest = await call(app, 'post', '/admin/wa/api/consent', { body: { wa_id: '237600000005' } });
  assert.equal(noAttest.statusCode, 400);
});

test('statuts : ordre sent < delivered < read, échec avec erreur', async () => {
  const { db, mod } = await setup();
  const sent = await mod.sendTemplate('237679064679', 'hello_world', 'en_US');
  const st = (status, errors) => ({ entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: sent.id, status, recipient_id: '237679064679', timestamp: '1', ...(errors ? { errors } : {}) }] } }] }] });
  const get = async () => (await db.execute({ sql: 'SELECT status, error FROM wa_messages WHERE id = ?', args: [sent.id] })).rows[0];
  await mod.handleWebhook(st('read')); assert.equal((await get()).status, 'read');
  await mod.handleWebhook(st('delivered')); assert.equal((await get()).status, 'read', 'pas de retour en arrière');
  await mod.handleWebhook(st('failed', [{ code: 131047, title: 'Re-engagement message' }]));
  const f = await get(); assert.equal(f.status, 'failed'); assert.match(f.error, /131047/);
});

test('notifications du portail : texte dans la fenêtre, modèle hors fenêtre', async () => {
  const { db, app, mod } = await setup();
  const { code } = (await call(app, 'post', '/api/wa/link-code')).payload;
  await mod.handleWebhook(inbound('237600000006', `TAKAMURA ${code}`)); await tick();
  calls.length = 0;
  let r = await mod.notifyTopupDecision(7, 'approved', 5000, 13000);
  assert.deepEqual([r.sent, r.via], [true, 'text']);
  assert.match(outMessages()[0].text.body, /5 000 FCFA[\s\S]*13 000 FCFA/);
  await db.execute(`UPDATE wa_contacts SET last_inbound_at = ${Date.now() - 2 * 86400000} WHERE wa_id = '237600000006'`);
  calls.length = 0;
  r = await mod.notifyReportReceived(7, 'TKM-9', 'Spam');
  assert.deepEqual([r.sent, r.via], [true, 'template']);
  const m = outMessages()[0];
  assert.equal(m.template.name, 'takamura_signalement_recu'); assert.equal(m.template.components[0].parameters[0].text, 'TKM-9');
  assert.equal((await mod.notifyUser(999, { text: 'x' })).reason, 'not_linked');
});

test('erreurs Meta : code, indice et statut HTTP', async () => {
  const { app } = await setup();
  await call(app, 'post', '/admin/wa/api/consent', { body: { wa_id: '237600000007', attest: true } });
  mockFetch(() => ({ status: 400, json: { error: { message: '(#131030) Recipient phone number not in allowed list', type: 'OAuthException', code: 131030, fbtrace_id: 'AbC' } } }));
  const r = await call(app, 'post', '/admin/wa/api/send', { body: { to: '237600000007', type: 'template', name: 'hello_world', lang: 'en_US' } });
  assert.equal(r.statusCode, 502); assert.equal(r.payload.code, 131030); assert.match(r.payload.hint, /liste autorisée/);
  const bad = await call(app, 'post', '/admin/wa/api/send', { body: { to: '12', type: 'text', text: 'x' } });
  assert.equal(bad.statusCode, 400);
});

test('modèles Takamura, média, profil, QR, groupes', async () => {
  const { app } = await setup();
  const p = await call(app, 'post', '/admin/wa/api/templates/presets');
  assert.deepEqual(p.payload.results.map((x) => x.name), ['takamura_recharge_ok', 'takamura_recharge_refusee', 'takamura_signalement_recu', 'takamura_code']);
  const created = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/4606356849653621/message_templates'));
  assert.equal(created.length, 4); assert.equal(created[3].body.category, 'AUTHENTICATION');
  const up = await call(app, 'post', '/admin/wa/api/upload', { body: { mime: 'application/pdf', filename: 'recu.pdf', data: Buffer.from('pdf').toString('base64') } });
  assert.equal(up.payload.id, '123');
  assert.ok(calls.some((c) => c.path.endsWith(`/${PHONE_ID}/media`)));
  const bad = await call(app, 'post', '/admin/wa/api/templates', { body: { name: 'x', body: 'Salut {{1}}', examples: [] } });
  assert.equal(bad.statusCode, 400);
  await call(app, 'post', '/admin/wa/api/profile', { body: { about: 'Takamura', websites: ['https://takamura-elite2026.up.railway.app'], vertical: 'OTHER' } });
  assert.ok(calls.some((c) => c.path.endsWith('/whatsapp_business_profile') && c.body.about === 'Takamura'));
  await call(app, 'post', '/admin/wa/api/qr', { body: { message: 'Bonjour' } });
  assert.ok(calls.some((c) => c.path.endsWith('/message_qrdls') && c.body.generate_qr_image === 'PNG'));
  await call(app, 'post', '/admin/wa/api/groups', { body: { subject: 'Clients', approval: true } });
  assert.ok(calls.some((c) => c.path.endsWith('/groups') && c.body.join_approval_mode === 'approval_required'));
  const g = await call(app, 'post', '/admin/wa/api/send', { body: { to: 'Q1ZHRVRHRV9H', group: true, type: 'text', text: 'Salut le groupe' } });
  assert.equal(g.payload.ok, true);
  assert.equal(outMessages().at(-1).recipient_type, 'group');
});

test('console admin : nonce injecté', async () => {
  const { app } = await setup();
  const r = await call(app, 'get', '/admin/whatsapp');
  assert.match(r.headers['Content-Security-Policy'], /script-src 'nonce-/);
  assert.ok(!r.payload.includes('{{NONCE}}'));
});
