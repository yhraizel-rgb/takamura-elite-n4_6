'use strict';
/* ============================================================================
   Takamura Elite — WhatsApp Business Cloud API
   Envoi (texte, modèles, médias, localisation, contacts, interactifs, Flows,
   réactions, lecture), réception (webhook : messages + statuts), gestion
   (modèles, profil, QR / liens wa.me, catalogue, groupes, médias) et
   notifications du portail. Aucune dépendance : fetch / FormData natifs.
   ========================================================================== */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DAY = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 90;

/* ================================ ERREURS ================================== */
class WaError extends Error {
  constructor(message, o = {}) {
    super(message);
    this.name = 'WaError';
    this.httpStatus = o.httpStatus || 502;
    this.code = o.code ?? null;
    this.subcode = o.subcode ?? null;
    this.details = o.details ?? null;
    this.hint = o.hint ?? null;
  }
}
const bad = (msg) => new WaError(msg, { httpStatus: 400, code: 'invalid' });

const HINTS = {
  190: 'Token expiré ou invalide : crée un token permanent (utilisateur système) et mets-le dans WHATSAPP_TOKEN.',
  10: 'Permission manquante : le token doit avoir whatsapp_business_messaging et whatsapp_business_management.',
  100: 'Paramètre invalide : vérifie les champs envoyés.',
  368: 'Compte temporairement restreint par Meta (politique).',
  130429: 'Trop de messages par seconde : réessaie dans un instant.',
  131026: "Message non délivrable : le numéro n'a pas WhatsApp, ou n'a pas accepté les dernières conditions.",
  131030: "Destinataire absent de la liste autorisée (numéro de test) : ajoute-le dans Configuration de l'API > À.",
  131047: "Fenêtre de 24 h fermée : le contact doit t'écrire, ou envoie un modèle approuvé.",
  131048: 'Limite de spam atteinte : ralentis les envois.',
  131049: 'Meta a bloqué ce message pour préserver la qualité de la conversation : réessaie plus tard.',
  131051: 'Type de message non pris en charge.',
  132000: 'Le nombre de paramètres ne correspond pas au modèle.',
  132001: 'Modèle introuvable : nom ou langue incorrects, ou pas encore approuvé.',
  132012: 'Format de paramètre invalide pour ce modèle.',
  132018: 'Un paramètre de modèle contient un retour à la ligne, une tabulation ou trop d\'espaces.',
  133010: 'Numéro non enregistré sur l\'API Cloud : ouvre /admin/wa-register.',
  80007: 'Limite de débit atteinte côté Meta : réessaie plus tard.',
};

/* ================================ OUTILS =================================== */
const digits = (n) => String(n || '').replace(/\D/g, '');
const str = (v, max, name, { required = true } = {}) => {
  const s = String(v ?? '').trim();
  if (!s) { if (required) throw bad(`${name} est requis.`); return ''; }
  if (s.length > max) throw bad(`${name} : ${max} caractères maximum (là : ${s.length}).`);
  return s;
};
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase();
const fmtAmount = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const tplParam = (v) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim().slice(0, 1024) || '-';
const trunc = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
const maskEmail = (e) => { const [u, d] = String(e || '').split('@'); return u && d ? `${u.slice(0, 2)}***@${d}` : '***'; };
const maskNumber = (n) => { const d = digits(n); return d.length > 7 ? `+${d.slice(0, 4)}•••••${d.slice(-3)}` : '+•••'; };
const safeEq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

const TPL = {
  RECHARGE_OK: 'takamura_recharge_ok',
  RECHARGE_KO: 'takamura_recharge_refusee',
  REPORT: 'takamura_signalement_recu',
  OTP: 'takamura_code',
};
const VERTICALS = ['UNDEFINED', 'OTHER', 'AUTO', 'BEAUTY', 'APPAREL', 'EDU', 'ENTERTAIN', 'EVENT_PLAN', 'FINANCE', 'GROCERY', 'GOVT', 'HOTEL', 'HEALTH', 'NONPROFIT', 'PROF_SERVICES', 'RETAIL', 'TRAVEL', 'RESTAURANT', 'NOT_A_BIZ'];

/* ============================ CONSTRUCTEURS DE MESSAGES ==================== */
function mediaRef(o, name = 'Média') {
  if (o.id) return { id: str(o.id, 40, `${name} (id)`) };
  const link = str(o.link, 2000, `${name} (lien)`);
  if (!/^https:\/\//i.test(link)) throw bad(`${name} : le lien doit commencer par https://`);
  return { link };
}
function headerOf(h) {
  if (!h) return undefined;
  if (typeof h === 'string') return { type: 'text', text: str(h, 60, 'En-tête') };
  if (h.type === 'text') return { type: 'text', text: str(h.text, 60, 'En-tête') };
  if (['image', 'video', 'document'].includes(h.type)) return { type: h.type, [h.type]: mediaRef(h, 'En-tête') };
  throw bad('En-tête : type inconnu (text, image, video, document).');
}
function interactiveBase(type, o, { headerAllowed = true } = {}) {
  const i = { type };
  if (headerAllowed && o.header) i.header = headerOf(o.header);
  i.body = { text: str(o.body, 1024, 'Corps du message') };
  if (o.footer) i.footer = { text: str(o.footer, 60, 'Pied de page') };
  return i;
}

const B = {
  text(text, { preview = false } = {}) {
    return { type: 'text', text: { body: str(text, 4096, 'Texte'), preview_url: !!preview } };
  },
  media(type, o) {
    const m = mediaRef(o, type);
    if (o.caption && ['image', 'video', 'document'].includes(type)) m.caption = str(o.caption, 1024, 'Légende');
    if (type === 'document' && o.filename) m.filename = str(o.filename, 240, 'Nom du fichier');
    return { type, [type]: m };
  },
  location(o) {
    const latitude = Number(o.latitude), longitude = Number(o.longitude);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) throw bad('Latitude invalide.');
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw bad('Longitude invalide.');
    const loc = { latitude, longitude };
    if (o.name) loc.name = str(o.name, 200, 'Nom du lieu');
    if (o.address) loc.address = str(o.address, 300, 'Adresse');
    return { type: 'location', location: loc };
  },
  contacts(o) {
    const list = Array.isArray(o.contacts) ? o.contacts : [o];
    if (!list.length || list.length > 10) throw bad('Contacts : 1 à 10.');
    return {
      type: 'contacts',
      contacts: list.map((c) => {
        const name = str(c.name || c.formatted_name, 100, 'Nom du contact');
        const out = { name: { formatted_name: name, first_name: name.split(' ')[0] } };
        const phones = [].concat(c.phones || c.phone || []).filter(Boolean);
        if (phones.length) out.phones = phones.map((p) => ({ phone: `+${digits(p)}`, type: 'CELL' }));
        const emails = [].concat(c.emails || c.email || []).filter(Boolean);
        if (emails.length) out.emails = emails.map((e) => ({ email: str(e, 200, 'E-mail'), type: 'WORK' }));
        if (!out.phones && !out.emails) throw bad('Chaque contact a besoin d\'un téléphone ou d\'un e-mail.');
        return out;
      }),
    };
  },
  reaction(o) {
    return { type: 'reaction', reaction: { message_id: str(o.message_id, 300, 'Message à réagir'), emoji: String(o.emoji ?? '') } };
  },
  template(o) {
    const name = String(o.name || '').trim();
    if (!/^[a-z0-9_]{1,512}$/.test(name)) throw bad('Nom de modèle invalide (minuscules, chiffres et _ uniquement).');
    const lang = String(o.lang || o.language || 'fr').trim();
    if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(lang)) throw bad('Code langue invalide (ex. fr, en_US).');
    let components = o.components;
    if (!components) {
      components = [];
      if (o.header) {
        const h = o.header;
        if (typeof h === 'string') components.push({ type: 'header', parameters: [{ type: 'text', text: tplParam(h) }] });
        else if (['image', 'video', 'document'].includes(h.type)) components.push({ type: 'header', parameters: [{ type: h.type, [h.type]: mediaRef(h, 'En-tête') }] });
        else if (h.type === 'text') components.push({ type: 'header', parameters: [{ type: 'text', text: tplParam(h.text) }] });
      }
      const params = [].concat(o.params || []).filter((p) => p !== undefined && p !== null && p !== '');
      if (params.length) components.push({ type: 'body', parameters: params.map((p) => ({ type: 'text', text: tplParam(p) })) });
      for (const b of o.buttons || []) {
        const sub = b.sub_type || 'quick_reply';
        const idx = String(b.index ?? 0);
        const parameters = sub === 'url' ? [{ type: 'text', text: tplParam(b.param) }]
          : sub === 'copy_code' ? [{ type: 'coupon_code', coupon_code: tplParam(b.param) }]
          : [{ type: 'payload', payload: String(b.param ?? '').slice(0, 256) }];
        components.push({ type: 'button', sub_type: sub, index: idx, parameters });
      }
    }
    return { type: 'template', template: { name, language: { code: lang }, ...(components.length ? { components } : {}) } };
  },
  interactive(kind, o) {
    let i;
    switch (kind) {
      case 'buttons': {
        const btns = Array.isArray(o.buttons) ? o.buttons : [];
        if (btns.length < 1 || btns.length > 3) throw bad('Boutons : 1 à 3.');
        i = interactiveBase('button', o);
        i.action = { buttons: btns.map((b) => ({ type: 'reply', reply: { id: str(b.id, 256, 'Id du bouton'), title: str(b.title, 20, 'Titre du bouton') } })) };
        break;
      }
      case 'list': {
        const sections = Array.isArray(o.sections) ? o.sections : [];
        const rows = sections.reduce((n, s) => n + (s.rows || []).length, 0);
        if (!sections.length || sections.length > 10) throw bad('Liste : 1 à 10 sections.');
        if (rows < 1 || rows > 10) throw bad('Liste : 1 à 10 lignes au total.');
        i = interactiveBase('list', o);
        i.action = {
          button: str(o.button || 'Options', 20, 'Texte du bouton'),
          sections: sections.map((s) => ({
            ...(s.title ? { title: str(s.title, 24, 'Titre de section') } : {}),
            rows: (s.rows || []).map((r) => ({
              id: str(r.id, 200, 'Id de ligne'), title: str(r.title, 24, 'Titre de ligne'),
              ...(r.description ? { description: str(r.description, 72, 'Description de ligne') } : {}),
            })),
          })),
        };
        break;
      }
      case 'cta_url': {
        const url = str(o.url, 2000, 'Lien');
        if (!/^https:\/\//i.test(url)) throw bad('Lien : doit commencer par https://');
        i = interactiveBase('cta_url', o);
        i.action = { name: 'cta_url', parameters: { display_text: str(o.text || o.display_text, 20, 'Texte du bouton'), url } };
        break;
      }
      case 'flow': {
        if (!o.flow_id && !o.flow_name) throw bad('Flow : flow_id ou flow_name requis.');
        i = interactiveBase('flow', o);
        const p = {
          flow_message_version: '3',
          flow_token: String(o.flow_token || crypto.randomBytes(8).toString('hex')),
          flow_cta: str(o.cta || o.flow_cta, 20, 'Texte du bouton Flow'),
          mode: o.mode === 'draft' ? 'draft' : 'published',
        };
        if (o.flow_id) p.flow_id = String(o.flow_id); else p.flow_name = String(o.flow_name);
        if (o.screen) { p.flow_action = 'navigate'; p.flow_action_payload = { screen: String(o.screen), ...(o.data ? { data: o.data } : {}) }; }
        i.action = { name: 'flow', parameters: p };
        break;
      }
      case 'location_request':
        i = { type: 'location_request_message', body: { text: str(o.body, 1024, 'Corps du message') }, action: { name: 'send_location' } };
        break;
      case 'call_permission':
        i = { type: 'call_permission_request', body: { text: str(o.body, 1024, 'Corps du message') }, action: { name: 'call_permission_request' } };
        break;
      case 'product': {
        i = { type: 'product' };
        if (o.body) i.body = { text: str(o.body, 1024, 'Corps du message') };
        if (o.footer) i.footer = { text: str(o.footer, 60, 'Pied de page') };
        i.action = { catalog_id: str(o.catalog_id, 40, 'Catalogue'), product_retailer_id: str(o.product_id, 100, 'Produit') };
        break;
      }
      case 'product_list': {
        const sections = Array.isArray(o.sections) ? o.sections : [];
        if (!sections.length) throw bad('Liste de produits : au moins une section.');
        i = interactiveBase('product_list', { ...o, header: undefined });
        i.header = { type: 'text', text: str(o.header, 60, 'En-tête') };
        i.action = {
          catalog_id: str(o.catalog_id, 40, 'Catalogue'),
          sections: sections.map((s) => ({
            title: str(s.title, 24, 'Titre de section'),
            product_items: (s.product_ids || []).map((p) => ({ product_retailer_id: str(p, 100, 'Produit') })),
          })),
        };
        break;
      }
      default: throw bad(`Type interactif inconnu : ${kind}`);
    }
    return { type: 'interactive', interactive: i };
  },
};

const INTERACTIVE_KINDS = ['buttons', 'list', 'cta_url', 'flow', 'location_request', 'call_permission', 'product', 'product_list'];
function buildMessage(inp) {
  const t = String(inp.type || 'text');
  let m;
  if (t === 'text') m = B.text(inp.text, { preview: inp.preview_url });
  else if (['image', 'video', 'audio', 'document', 'sticker'].includes(t)) m = B.media(t, inp);
  else if (t === 'location') m = B.location(inp);
  else if (t === 'contacts') m = B.contacts(inp);
  else if (t === 'reaction') m = B.reaction(inp);
  else if (t === 'template') m = B.template(inp);
  else if (INTERACTIVE_KINDS.includes(t)) m = B.interactive(t, inp);
  else throw bad(`Type de message inconnu : ${t}`);
  if (inp.reply_to && t !== 'reaction') m.context = { message_id: String(inp.reply_to) };
  return m;
}

function summarize(msg) {
  const t = msg.type;
  switch (t) {
    case 'text': return { body: msg.text.body };
    case 'template': return { body: `[modèle] ${msg.template.name}` };
    case 'location': return { body: `[position] ${msg.location.name || `${msg.location.latitude},${msg.location.longitude}`}` };
    case 'contacts': return { body: `[contact] ${msg.contacts.map((c) => c.name.formatted_name).join(', ')}` };
    case 'reaction': return { body: msg.reaction.emoji || '(réaction retirée)' };
    case 'interactive': {
      const i = msg.interactive;
      return { body: `[${i.type}] ${i.body?.text || ''}` };
    }
    default: {
      const m = msg[t] || {};
      return { body: `[${t}] ${m.caption || m.filename || ''}`.trim(), mediaId: m.id || null };
    }
  }
}

/* ================================ MODULE =================================== */
function create(deps) {
  const { app, db, env, getUserFromToken, adminAuth, requireAdminXhr, limitAdmin, rateLimit } = deps;
  const walletCurrency = deps.walletCurrency || 'FCFA';

  const cfg = {
    token: env('WHATSAPP_TOKEN', 'EAAds30j9eC4BSgXZASzWFYUWmiZAnVZBZBNgZAcXayfuVqm38wvvyBi5RmLLnWUBBgv7dAM1ZC4K0FDGfR6SnuHNrlft6wcZAZCdjebgRh0KWxzvTvcctsgMLAywGqoO1llfY4V2PDSHW80uEZB5mSxhqplbehMzctLnbdq63NRZCmflgOa1Gn06DcQpDIdHiLgLVyTWur8FxoxHbwjvLQea4Np9YWgJtnQIYp'),
    phoneId: env('WHATSAPP_PHONE_NUMBER_ID', '1370755836117468'),
    wabaId: env('WHATSAPP_WABA_ID', '4606356849653621'),
    appId: env('WHATSAPP_APP_ID', ''),
    appSecret: env('WHATSAPP_APP_SECRET', ''),
    verifyToken: env('VERIFY_TOKEN', 'takamura_verif_2026'),
    version: env('WHATSAPP_GRAPH_VERSION', 'v23.0'),
    businessNumber: digits(env('WHATSAPP_BUSINESS_NUMBER', '15556484842')),
    publicUrl: env('PUBLIC_URL', 'https://takamura-elite2026.up.railway.app').replace(/\/+$/, ''),
    pin: env('WHATSAPP_PIN', '482915'),
    ownerNumber: digits(env('WHATSAPP_OWNER_NUMBER', '237679064679')),
    autoReply: env('WHATSAPP_AUTOREPLY', '1') !== '0',
    debug: env('WHATSAPP_DEBUG', '') === '1',
  };

  const run = (sql, args = []) => db.execute({ sql, args: args.map((a) => (a === undefined ? null : a)) });
  const affected = (r) => Number((r && (r.rowsAffected ?? r.rows_affected)) || 0);

  /* ------------------------------- Graph API ------------------------------- */
  async function graph(method, p, { query, json, form, rawBody, headers, authScheme = 'Bearer', timeout = 20000 } = {}) {
    const url = new URL(`https://graph.facebook.com/${cfg.version}/${String(p).replace(/^\/+/, '')}`);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    const h = { Authorization: `${authScheme} ${cfg.token}`, ...(headers || {}) };
    let body;
    if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    else if (form) body = form;
    else if (rawBody) body = rawBody;
    let res;
    try { res = await fetch(url, { method, headers: h, body, signal: AbortSignal.timeout(timeout) }); }
    catch (e) { throw new WaError(`Réseau : ${e.message}`, { httpStatus: 504, code: 'network' }); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      const er = data.error || {};
      const detail = er.error_data && er.error_data.details;
      throw new WaError(detail ? `${er.message || 'Erreur'} — ${detail}` : (er.message || `Erreur API (${res.status})`), {
        code: er.code ?? res.status, subcode: er.error_subcode, hint: HINTS[er.code] || null,
        details: { type: er.type, fbtrace_id: er.fbtrace_id },
      });
    }
    return data;
  }

  /* ------------------------------ Base de données -------------------------- */
  async function initDb() {
    await run(`CREATE TABLE IF NOT EXISTS wa_contacts (
      wa_id TEXT PRIMARY KEY, name TEXT, user_id INTEGER,
      opted_in INTEGER NOT NULL DEFAULT 0, opted_out INTEGER NOT NULL DEFAULT 0,
      consent_source TEXT, consent_at INTEGER, last_inbound_at INTEGER, created_at INTEGER NOT NULL)`);
    await run(`CREATE TABLE IF NOT EXISTS wa_messages (
      id TEXT PRIMARY KEY, wa_id TEXT NOT NULL, direction TEXT NOT NULL, type TEXT, body TEXT, media_id TEXT,
      payload TEXT, status TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_wa_messages_contact ON wa_messages(wa_id, created_at)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_wa_contacts_user ON wa_contacts(user_id)`);
    await run(`CREATE TABLE IF NOT EXISTS wa_link_codes (code TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
    await run(`CREATE TABLE IF NOT EXISTS wa_events (id INTEGER PRIMARY KEY AUTOINCREMENT, field TEXT, payload TEXT, created_at INTEGER NOT NULL)`);
    if (cfg.ownerNumber) {
      await run(`INSERT OR IGNORE INTO wa_contacts (wa_id, name, opted_in, consent_source, consent_at, created_at) VALUES (?, 'Propriétaire', 1, 'owner', ?, ?)`,
        [cfg.ownerNumber, Date.now(), Date.now()]);
    }
    await purgeOld();
  }
  async function purgeOld() {
    const cut = Date.now() - RETENTION_DAYS * DAY;
    await run(`DELETE FROM wa_messages WHERE created_at < ?`, [cut]);
    await run(`DELETE FROM wa_events WHERE created_at < ?`, [cut]);
    await run(`DELETE FROM wa_link_codes WHERE expires_at < ?`, [Date.now()]);
  }
  let readyPromise;
  const ready = () => (readyPromise ||= initDb().then(() => {
    setInterval(() => purgeOld().catch(() => {}), DAY).unref();
  }));

  const getContact = async (waId) => (await run(`SELECT * FROM wa_contacts WHERE wa_id = ?`, [waId])).rows[0] || null;
  async function touchContact(waId, { name, inboundAt } = {}) {
    await run(`INSERT INTO wa_contacts (wa_id, name, last_inbound_at, created_at) VALUES (?, ?, ?, ?)
               ON CONFLICT(wa_id) DO UPDATE SET name = COALESCE(excluded.name, wa_contacts.name),
               last_inbound_at = COALESCE(excluded.last_inbound_at, wa_contacts.last_inbound_at)`,
    [waId, name || null, inboundAt || null, Date.now()]);
  }
  async function setConsent(waId, { source, name } = {}) {
    await run(`INSERT INTO wa_contacts (wa_id, name, opted_in, opted_out, consent_source, consent_at, created_at) VALUES (?, ?, 1, 0, ?, ?, ?)
               ON CONFLICT(wa_id) DO UPDATE SET opted_in = 1, opted_out = 0, consent_source = excluded.consent_source,
               consent_at = excluded.consent_at, name = COALESCE(excluded.name, wa_contacts.name)`,
    [waId, name || null, source || 'admin', Date.now(), Date.now()]);
  }
  const setOptOut = (waId) => run(`UPDATE wa_contacts SET opted_out = 1, opted_in = 0 WHERE wa_id = ?`, [waId]);

  async function recordMessage({ id, waId, direction, type, body, mediaId, payload, status, error, at }) {
    const t = at || Date.now();
    await run(`INSERT OR IGNORE INTO wa_messages (id, wa_id, direction, type, body, media_id, payload, status, error, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, waId, direction, type, trunc(body || '', 4000), mediaId || null, payload ? trunc(JSON.stringify(payload), 6000) : null, status, error || null, t, t]);
  }

  /* --------------------------------- Envoi --------------------------------- */
  async function assertCanSend(waId, kind) {
    const c = await getContact(waId);
    if (c && Number(c.opted_out)) throw new WaError("Ce contact s'est désinscrit (STOP) : aucun message ne peut lui être envoyé.", { httpStatus: 403, code: 'opted_out' });
    const age = c && c.last_inbound_at ? Date.now() - Number(c.last_inbound_at) : Infinity;
    if (kind === 'session') {
      if (age >= DAY) throw new WaError("Fenêtre de 24 h fermée : le contact doit t'écrire d'abord, ou envoie un modèle approuvé.", { httpStatus: 409, code: 'window_closed', hint: HINTS[131047] });
      return;
    }
    if (!(c && Number(c.opted_in)) && age >= DAY) {
      throw new WaError("Aucun consentement enregistré pour ce numéro : fais-le lier son compte (portail) ou enregistre son accord dans l'Inbox.", { httpStatus: 403, code: 'no_consent' });
    }
  }

  async function send(to, msg, { group = false, skipGate = false } = {}) {
    const dest = group ? String(to || '').trim() : digits(to);
    if (!group && !/^\d{8,15}$/.test(dest)) throw bad("Numéro invalide : indique-le avec l'indicatif pays, sans « + » (ex. 237679064679).");
    if (group && !/^[\w.@-]{5,80}$/.test(dest)) throw bad('Identifiant de groupe invalide.');
    if (!group && !skipGate) await assertCanSend(dest, msg.type === 'template' ? 'template' : 'session');
    const sum = summarize(msg);
    try {
      const out = await graph('POST', `${cfg.phoneId}/messages`, { json: { messaging_product: 'whatsapp', recipient_type: group ? 'group' : 'individual', to: dest, ...msg } });
      const id = (out.messages && out.messages[0] && out.messages[0].id) || `local-${crypto.randomUUID()}`;
      await recordMessage({ id, waId: dest, direction: 'out', type: msg.type, body: sum.body, mediaId: sum.mediaId, status: 'accepted' }).catch((e) => console.error('[WA db]', e.message));
      return { id, to: dest, status: 'accepted' };
    } catch (e) {
      await recordMessage({ id: `fail-${crypto.randomUUID()}`, waId: dest, direction: 'out', type: msg.type, body: sum.body, status: 'failed', error: e.message }).catch(() => {});
      throw e;
    }
  }
  const sendText = (to, text, opts) => send(to, B.text(text, opts));
  const sendTemplate = (to, name, lang = 'fr', params = [], extra = {}) => send(to, B.template({ name, lang, params, ...extra }));
  async function sendOtp(to, code) {
    const dest = digits(to);
    const c = await getContact(dest);
    if (c && Number(c.opted_out)) throw new WaError('Contact désinscrit.', { httpStatus: 403, code: 'opted_out' });
    const c6 = String(code).slice(0, 15);
    return send(dest, B.template({ name: TPL.OTP, lang: 'fr', components: [
      { type: 'body', parameters: [{ type: 'text', text: c6 }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: c6 }] },
    ] }), { skipGate: true });
  }
  async function markRead(messageId, { typing = false } = {}) {
    const json = { messaging_product: 'whatsapp', status: 'read', message_id: String(messageId) };
    if (typing) json.typing_indicator = { type: 'text' };
    const out = await graph('POST', `${cfg.phoneId}/messages`, { json });
    await run(`UPDATE wa_messages SET status = 'read', updated_at = ? WHERE id = ? AND direction = 'in'`, [Date.now(), String(messageId)]).catch(() => {});
    return out;
  }

  /* -------------------------------- Médias --------------------------------- */
  async function uploadMedia(buf, mime, filename) {
    if (!buf || !buf.length) throw bad('Fichier vide.');
    if (buf.length > 16 * 1024 * 1024) throw bad('Fichier trop gros (16 Mo maximum ici).');
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mime);
    form.append('file', new Blob([buf], { type: mime }), filename || 'fichier');
    return graph('POST', `${cfg.phoneId}/media`, { form, timeout: 60000 });
  }
  async function downloadMedia(id) {
    const meta = await graph('GET', String(id));
    if (!meta.url) throw new WaError('Média introuvable ou expiré (Meta les garde 30 jours).', { httpStatus: 404, code: 'media' });
    if (Number(meta.file_size) > 25 * 1024 * 1024) throw bad('Média trop volumineux.');
    let res;
    try { res = await fetch(meta.url, { headers: { Authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(60000) }); }
    catch (e) { throw new WaError(`Réseau : ${e.message}`, { httpStatus: 504 }); }
    if (!res.ok) throw new WaError(`Téléchargement refusé (${res.status}).`, { httpStatus: 502 });
    return { buffer: Buffer.from(await res.arrayBuffer()), mime: meta.mime_type || 'application/octet-stream', size: meta.file_size, sha256: meta.sha256 };
  }

  /* -------------------------------- Modèles -------------------------------- */
  const listTemplates = async () => (await graph('GET', `${cfg.wabaId}/message_templates`, { query: { fields: 'name,status,category,language,components,rejected_reason,quality_score', limit: 100 } })).data || [];
  const createTemplate = (t) => graph('POST', `${cfg.wabaId}/message_templates`, { json: t });
  const deleteTemplate = (name) => graph('DELETE', `${cfg.wabaId}/message_templates`, { query: { name } });
  function templateFromInput(inp) {
    const name = String(inp.name || '').trim();
    if (!/^[a-z0-9_]{1,512}$/.test(name)) throw bad('Nom : minuscules, chiffres et _ uniquement.');
    const category = String(inp.category || 'UTILITY').toUpperCase();
    if (!['UTILITY', 'MARKETING'].includes(category)) throw bad('Catégorie : UTILITY ou MARKETING (AUTHENTICATION via les modèles Takamura).');
    const components = [];
    if (inp.header) components.push({ type: 'HEADER', format: 'TEXT', text: str(inp.header, 60, 'En-tête') });
    const text = str(inp.body, 1024, 'Corps');
    const n = (text.match(/\{\{\d+\}\}/g) || []).length;
    const body = { type: 'BODY', text };
    if (n) {
      const ex = [].concat(inp.examples || []).map(String).filter(Boolean);
      if (ex.length !== n) throw bad(`Le corps contient ${n} variable(s) : donne ${n} exemple(s), séparés par « | ».`);
      body.example = { body_text: [ex] };
    }
    components.push(body);
    if (inp.footer) components.push({ type: 'FOOTER', text: str(inp.footer, 60, 'Pied de page') });
    const buttons = (inp.buttons || []).map((b) => {
      if (b.type === 'URL') return { type: 'URL', text: str(b.text, 25, 'Bouton'), url: str(b.url, 2000, 'Lien du bouton') };
      if (b.type === 'PHONE_NUMBER') return { type: 'PHONE_NUMBER', text: str(b.text, 25, 'Bouton'), phone_number: `+${digits(b.phone_number)}` };
      return { type: 'QUICK_REPLY', text: str(b.text, 25, 'Bouton') };
    });
    if (buttons.length) components.push({ type: 'BUTTONS', buttons });
    return { name, category, language: String(inp.language || 'fr'), components };
  }
  const presetTemplates = () => [
    { name: TPL.RECHARGE_OK, category: 'UTILITY', language: 'fr', components: [{ type: 'BODY', text: 'Bonjour, votre recharge de {{1}} FCFA a été approuvée. Nouveau solde : {{2}} FCFA.', example: { body_text: [['5 000', '8 000']] } }, { type: 'FOOTER', text: 'Takamura Elite' }] },
    { name: TPL.RECHARGE_KO, category: 'UTILITY', language: 'fr', components: [{ type: 'BODY', text: "Bonjour, votre demande de recharge de {{1}} FCFA n'a pas pu être validée (preuve introuvable ou incorrecte). Vous pouvez soumettre une nouvelle demande depuis votre compte.", example: { body_text: [['5 000']] } }, { type: 'FOOTER', text: 'Takamura Elite' }] },
    { name: TPL.REPORT, category: 'UTILITY', language: 'fr', components: [{ type: 'BODY', text: 'Bonjour, votre signalement {{1}} a bien été enregistré. Vous pouvez suivre son état dans votre historique.', example: { body_text: [['TKM-20261006-A1B2C3']] } }, { type: 'FOOTER', text: 'Takamura Elite' }] },
    { name: TPL.OTP, category: 'AUTHENTICATION', language: 'fr', components: [{ type: 'BODY', add_security_recommendation: true }, { type: 'FOOTER', code_expiration_minutes: 15 }, { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copier le code' }] }] },
  ];

  /* --------------------------- Notifications du portail -------------------- */
  async function notifyUser(userId, { text, template }) {
    try {
      const r = await run(`SELECT wa_id, last_inbound_at FROM wa_contacts WHERE user_id = ? AND opted_in = 1 AND opted_out = 0 LIMIT 1`, [userId]);
      const c = r.rows[0];
      if (!c) return { sent: false, reason: 'not_linked' };
      const open = c.last_inbound_at && Date.now() - Number(c.last_inbound_at) < DAY;
      if (open && text) {
        try { await send(c.wa_id, B.text(text)); return { sent: true, via: 'text' }; } catch (e) { if (!template) throw e; }
      }
      if (template) { await send(c.wa_id, B.template(template)); return { sent: true, via: 'template' }; }
      return { sent: false, reason: 'window_closed' };
    } catch (e) {
      console.error('[WA notify]', e.message);
      return { sent: false, reason: 'error', error: e.message };
    }
  }
  const notifyTopupDecision = (userId, decision, amount, balance) => (decision === 'approved'
    ? notifyUser(userId, {
      text: `✅ Recharge approuvée\nMontant : ${fmtAmount(amount)} ${walletCurrency}\nNouveau solde : ${fmtAmount(balance)} ${walletCurrency}\n\nTakamura Elite`,
      template: { name: TPL.RECHARGE_OK, lang: 'fr', params: [fmtAmount(amount), fmtAmount(balance)] },
    })
    : notifyUser(userId, {
      text: `❌ Recharge refusée\nMontant : ${fmtAmount(amount)} ${walletCurrency}\nLa preuve de paiement est introuvable ou incorrecte. Tu peux soumettre une nouvelle demande depuis ton compte.\n\nTakamura Elite`,
      template: { name: TPL.RECHARGE_KO, lang: 'fr', params: [fmtAmount(amount)] },
    }));
  const notifyReportReceived = (userId, caseId, category) => notifyUser(userId, {
    text: `📨 Signalement enregistré\nDossier : ${caseId}\nCatégorie : ${category}\n\nTu retrouves son suivi dans ton historique.\nTakamura Elite`,
    template: { name: TPL.REPORT, lang: 'fr', params: [caseId] },
  });

  /* ------------------------------ Réception -------------------------------- */
  function extractInbound(m) {
    const t = m.type;
    const o = { type: t, text: '', mediaId: null, cmdId: null, extra: null };
    switch (t) {
      case 'text': o.text = (m.text && m.text.body) || ''; break;
      case 'image': case 'video': case 'audio': case 'document': case 'sticker': {
        const x = m[t] || {};
        o.mediaId = x.id || null; o.text = x.caption || x.filename || ''; o.extra = { mime: x.mime_type, filename: x.filename };
        break;
      }
      case 'location': {
        const l = m.location || {};
        o.text = [l.name, l.address].filter(Boolean).join(' — ') || `${l.latitude},${l.longitude}`; o.extra = l;
        break;
      }
      case 'contacts': o.text = (m.contacts || []).map((c) => c.name && c.name.formatted_name).filter(Boolean).join(', '); o.extra = m.contacts; break;
      case 'interactive': {
        const i = m.interactive || {};
        const r = i.button_reply || i.list_reply;
        if (r) { o.cmdId = r.id; o.text = r.title || r.id; }
        else if (i.nfm_reply) { o.text = 'Réponse au formulaire (Flow)'; o.extra = { response_json: i.nfm_reply.response_json }; }
        break;
      }
      case 'button': o.cmdId = (m.button && m.button.payload) || null; o.text = (m.button && m.button.text) || ''; break;
      case 'reaction': o.text = (m.reaction && m.reaction.emoji) || ''; o.extra = { message_id: m.reaction && m.reaction.message_id }; break;
      case 'order': o.text = `Commande (${((m.order && m.order.product_items) || []).length} article(s))`; o.extra = m.order; break;
      case 'system': o.text = (m.system && m.system.body) || 'Message système'; break;
      default: o.text = (m.errors && m.errors[0] && m.errors[0].title) || `[${t}]`;
    }
    return o;
  }

  const replyLog = new Map(); // anti-boucle : max 8 réponses auto / 10 min / contact
  function replyAllowed(waId) {
    const now = Date.now();
    const list = (replyLog.get(waId) || []).filter((t) => now - t < 10 * 60 * 1000);
    if (list.length >= 8) { replyLog.set(waId, list); return false; }
    list.push(now); replyLog.set(waId, list);
    return true;
  }
  const lastMenu = new Map();
  const MENU_IDS = { menu_balance: 'SOLDE', menu_history: 'HISTORIQUE', menu_recharge: 'RECHARGE', menu_help: 'AIDE', menu_stop: 'STOP' };

  async function sendMenu(waId) {
    await send(waId, B.interactive('list', {
      body: 'Bonjour 👋 Que veux-tu faire ?',
      footer: 'Takamura Elite',
      button: 'Options',
      sections: [{ title: 'Mon compte', rows: [
        { id: 'menu_balance', title: 'Mon solde' },
        { id: 'menu_history', title: 'Mes signalements' },
        { id: 'menu_recharge', title: 'Recharger' },
        { id: 'menu_help', title: 'Aide' },
        { id: 'menu_stop', title: 'Arrêter les messages' },
      ] }],
    }));
  }

  async function linkedUser(waId) {
    const r = await run(`SELECT u.id, u.email, u.balance FROM wa_contacts c JOIN users u ON u.id = c.user_id WHERE c.wa_id = ?`, [waId]);
    return r.rows[0] || null;
  }

  async function tryLink(waId, text) {
    const m = /\bTAKAMURA[\s:_-]*([A-HJ-NP-Z2-9]{6})\b/i.exec(text || '');
    if (!m) return false;
    const code = m[1].toUpperCase();
    const r = await run(`SELECT user_id, expires_at FROM wa_link_codes WHERE code = ?`, [code]);
    const row = r.rows[0];
    if (!row || Number(row.expires_at) < Date.now()) {
      await sendText(waId, "Ce code n'est plus valide. Génère-en un nouveau depuis ton compte (Notifications WhatsApp), puis renvoie-le ici.");
      return true;
    }
    await run(`UPDATE wa_contacts SET user_id = NULL WHERE user_id = ? AND wa_id <> ?`, [row.user_id, waId]);
    await setConsent(waId, { source: 'whatsapp:link' });
    await run(`UPDATE wa_contacts SET user_id = ? WHERE wa_id = ?`, [row.user_id, waId]);
    await run(`DELETE FROM wa_link_codes WHERE code = ? OR user_id = ?`, [code, row.user_id]);
    const u = (await run(`SELECT email FROM users WHERE id = ?`, [row.user_id])).rows[0];
    await sendText(waId, `✅ Ton WhatsApp est lié au compte ${maskEmail(u && u.email)}.\nTu recevras ici tes confirmations de recharge et de signalement.\n\nEnvoie MENU pour les options ou STOP pour ne plus rien recevoir.`);
    return true;
  }

  async function autoReply(waId, inb) {
    if (!cfg.autoReply) return;
    if (!['text', 'interactive', 'button'].includes(inb.type)) return;
    const raw = inb.cmdId && MENU_IDS[inb.cmdId] ? MENU_IDS[inb.cmdId] : norm(inb.text);
    if (await tryLink(waId, inb.text)) return;

    if (/^(STOP|STOP ALL|ARRET|ARRETER|DESABONNER|UNSUBSCRIBE|NON MERCI)$/.test(raw)) {
      // On confirme AVANT de bloquer (sinon la confirmation serait elle-même refusée), puis on désinscrit quoi qu'il arrive.
      try { await sendText(waId, 'C\'est noté : tu ne recevras plus de messages de notre part. Envoie START pour les réactiver.'); }
      finally { await setOptOut(waId); }
      return;
    }
    const c = await getContact(waId);
    if (/^(START|OUI|ACTIVER|REPRENDRE)$/.test(raw)) {
      if (c && c.user_id) {
        await setConsent(waId, { source: 'whatsapp:start' });
        await sendText(waId, '✅ Les notifications sont réactivées.');
      } else {
        await sendText(waId, 'Pour recevoir des notifications, lie ton WhatsApp depuis ton compte sur le portail (Notifications WhatsApp).');
      }
      return;
    }
    if (c && Number(c.opted_out)) return; // plus aucune réponse automatique après un STOP
    if (!replyAllowed(waId)) return;

    if (/^(SOLDE|BALANCE)$/.test(raw)) {
      const u = await linkedUser(waId);
      await sendText(waId, u ? `💰 Ton solde : ${fmtAmount(u.balance)} ${walletCurrency}` : "Ton WhatsApp n'est pas lié à un compte. Lie-le depuis ton compte sur le portail.");
      return;
    }
    if (/^(HISTORIQUE|SIGNALEMENTS|HISTORY)$/.test(raw)) {
      const u = await linkedUser(waId);
      if (!u) { await sendText(waId, "Ton WhatsApp n'est pas lié à un compte. Lie-le depuis ton compte sur le portail."); return; }
      const rows = (await run(`SELECT case_id, category, created_at FROM reports WHERE user_id = ? ORDER BY created_at DESC LIMIT 5`, [u.id])).rows;
      await sendText(waId, rows.length
        ? `📋 Tes derniers signalements :\n${rows.map((r) => `• ${r.case_id} — ${r.category} (${new Date(Number(r.created_at)).toISOString().slice(0, 10)})`).join('\n')}`
        : 'Tu n\'as pas encore de signalement.');
      return;
    }
    if (/^(RECHARGE|RECHARGER)$/.test(raw)) {
      await send(waId, B.interactive('cta_url', { body: 'Pour recharger ton portefeuille, ouvre ton compte sur le portail.', text: 'Ouvrir le portail', url: cfg.publicUrl }));
      return;
    }
    if (/^(AIDE|HELP|MENU|\?)$/.test(raw)) { lastMenu.set(waId, Date.now()); await sendMenu(waId); return; }

    // Message libre : on propose le menu (au plus une fois toutes les 5 minutes).
    if (Date.now() - (lastMenu.get(waId) || 0) > 5 * 60 * 1000) { lastMenu.set(waId, Date.now()); await sendMenu(waId); }
  }

  async function processInbound(m, names) {
    const waId = digits(m.from);
    const at = Number(m.timestamp) * 1000 || Date.now();
    const inb = extractInbound(m);
    const fresh = affected(await run(`INSERT OR IGNORE INTO wa_messages (id, wa_id, direction, type, body, media_id, payload, status, created_at, updated_at)
      VALUES (?, ?, 'in', ?, ?, ?, ?, 'received', ?, ?)`,
    [m.id, waId, inb.type, trunc(inb.text || '', 4000), inb.mediaId, inb.extra ? trunc(JSON.stringify(inb.extra), 6000) : null, at, at]));
    if (!fresh) return; // doublon (Meta relance les webhooks)
    await touchContact(waId, { name: names[waId], inboundAt: at });
    if (cfg.debug) console.log('[WA in]', JSON.stringify(m).slice(0, 1500)); else console.log(`[WA in] ${maskNumber(waId)} ${inb.type}`);
    if (!['reaction', 'system'].includes(inb.type)) markRead(m.id, { typing: ['text', 'interactive', 'button'].includes(inb.type) && cfg.autoReply }).catch(() => {});
    try { await autoReply(waId, inb); } catch (e) { console.error('[WA autoreply]', e.message); }
  }

  const RANK = { accepted: 0, sent: 1, delivered: 2, read: 3 };
  async function processStatus(st) {
    const s = String(st.status || '');
    if (!st.id || !s) return;
    const e0 = st.errors && st.errors[0];
    const err = e0 ? `${e0.code}: ${e0.title || e0.message || ''}${e0.error_data && e0.error_data.details ? ` — ${e0.error_data.details}` : ''}` : null;
    const cur = (await run(`SELECT status FROM wa_messages WHERE id = ?`, [st.id])).rows[0];
    const now = Date.now();
    if (!cur) {
      await recordMessage({ id: st.id, waId: digits(st.recipient_id), direction: 'out', type: 'unknown', body: '(envoyé hors portail)', status: s, error: err, at: Number(st.timestamp) * 1000 || now });
    } else if (s === 'failed' || cur.status === 'failed' || (RANK[s] ?? -1) > (RANK[cur.status] ?? -1)) {
      await run(`UPDATE wa_messages SET status = ?, error = ?, updated_at = ? WHERE id = ?`, [s, err, now, st.id]);
    }
    if (s === 'failed') console.error(`[WA status] échec ${st.id}: ${err}`);
  }

  async function handleWebhook(body) {
    if (!body || !Array.isArray(body.entry)) return;
    for (const entry of body.entry) {
      for (const ch of entry.changes || []) {
        const v = ch.value || {};
        try {
          if (ch.field === 'messages') {
            const names = {};
            for (const c of v.contacts || []) if (c.wa_id) names[digits(c.wa_id)] = c.profile && c.profile.name;
            for (const m of v.messages || []) { try { await processInbound(m, names); } catch (e) { console.error('[WA inbound]', e.message); } }
            for (const st of v.statuses || []) { try { await processStatus(st); } catch (e) { console.error('[WA status]', e.message); } }
            if (v.errors && v.errors.length) await run(`INSERT INTO wa_events (field, payload, created_at) VALUES ('errors', ?, ?)`, [trunc(JSON.stringify(v.errors), 4000), Date.now()]);
          } else {
            await run(`INSERT INTO wa_events (field, payload, created_at) VALUES (?, ?, ?)`, [String(ch.field || '?'), trunc(JSON.stringify(v), 6000), Date.now()]);
          }
        } catch (e) { console.error('[WA webhook]', ch.field, e.message); }
      }
    }
  }

  /* --------------------------------- Routes -------------------------------- */
  const wrap = (fn) => async (req, res) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (e) {
      const status = e.httpStatus || 500;
      if (status >= 500) console.error('[WA route]', req.path, e.message);
      if (!res.headersSent) res.status(status).json({ ok: false, error: e.message, code: e.code ?? undefined, hint: e.hint || undefined, details: e.details || undefined });
    }
  };
  const adm = (method, p, fn) => app[method](p, limitAdmin, adminAuth, ...(method === 'get' ? [] : [requireAdminXhr]), wrap(fn));

  // --- Webhook Meta
  app.get('/webhook/whatsapp', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && safeEq(req.query['hub.verify_token'] || '', cfg.verifyToken)) {
      return res.status(200).type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
    }
    res.sendStatus(403);
  });
  app.post('/webhook/whatsapp', (req, res) => {
    if (cfg.appSecret) {
      const sig = String(req.get('x-hub-signature-256') || '');
      const expected = 'sha256=' + crypto.createHmac('sha256', cfg.appSecret).update(req.rawBody || Buffer.alloc(0)).digest('hex');
      if (!safeEq(sig, expected)) return res.sendStatus(403);
    }
    res.sendStatus(200); // toujours répondre vite : Meta relance sinon
    setImmediate(() => handleWebhook(req.body).catch((e) => console.error('[WA webhook]', e.message)));
  });

  // --- Côté client (portail) : lier son WhatsApp par un message prouvant la possession du numéro
  const limitLink = rateLimit({ windowMs: 60 * 60 * 1000, max: 10 });
  const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const userRoute = (fn) => wrap(async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) throw new WaError('Not authenticated.', { httpStatus: 401 });
    return fn(user, req, res);
  });
  app.get('/api/wa/status', userRoute(async (user) => {
    const c = (await run(`SELECT wa_id, opted_in, opted_out FROM wa_contacts WHERE user_id = ?`, [user.id])).rows[0];
    return { enabled: !!(cfg.token && cfg.phoneId), linked: !!(c && Number(c.opted_in) && !Number(c.opted_out)), optedOut: !!(c && Number(c.opted_out)), number: c ? maskNumber(c.wa_id) : null };
  }));
  app.post('/api/wa/link-code', limitLink, userRoute(async (user) => {
    let code = '';
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    await run(`DELETE FROM wa_link_codes WHERE user_id = ?`, [user.id]);
    await run(`INSERT INTO wa_link_codes (code, user_id, expires_at) VALUES (?, ?, ?)`, [code, user.id, Date.now() + 15 * 60 * 1000]);
    return { code, link: `https://wa.me/${cfg.businessNumber}?text=${encodeURIComponent(`TAKAMURA ${code}`)}`, expiresInMinutes: 15 };
  }));
  app.post('/api/wa/unlink', userRoute(async (user) => {
    await run(`UPDATE wa_contacts SET user_id = NULL, opted_in = 0 WHERE user_id = ?`, [user.id]);
    return { ok: true };
  }));

  // --- Console admin
  const CONSOLE_HTML = fs.readFileSync(path.join(__dirname, 'admin-whatsapp.html'), 'utf8');
  app.get('/admin/whatsapp', limitAdmin, adminAuth, (_req, res) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.set({
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src 'self' data:; media-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      'Cache-Control': 'no-store',
    });
    res.type('html').send(CONSOLE_HTML.replaceAll('{{NONCE}}', nonce));
  });

  adm('get', '/admin/wa/api/overview', async () => {
    let phone = null, phoneError = null;
    for (const fields of ['display_phone_number,verified_name,quality_rating,name_status,messaging_limit_tier,platform_type,throughput,code_verification_status,status', 'display_phone_number,verified_name,quality_rating']) {
      try { phone = await graph('GET', cfg.phoneId, { query: { fields } }); phoneError = null; break; } catch (e) { phoneError = { error: e.message, hint: e.hint }; }
    }
    const [contacts, msgs, today] = await Promise.all([
      run(`SELECT COUNT(*) AS c FROM wa_contacts`), run(`SELECT COUNT(*) AS c FROM wa_messages`),
      run(`SELECT COUNT(*) AS c FROM wa_messages WHERE direction = 'out' AND created_at > ?`, [Date.now() - DAY]),
    ]);
    const events = (await run(`SELECT id, field, payload, created_at FROM wa_events ORDER BY id DESC LIMIT 30`)).rows;
    return {
      ok: true, phone, phoneError,
      config: { phoneId: cfg.phoneId, wabaId: cfg.wabaId, version: cfg.version, businessNumber: cfg.businessNumber, appSecret: !!cfg.appSecret, appId: !!cfg.appId, autoReply: cfg.autoReply, publicUrl: cfg.publicUrl },
      counts: { contacts: Number(contacts.rows[0].c), messages: Number(msgs.rows[0].c), sent24h: Number(today.rows[0].c) },
      events,
    };
  });
  adm('get', '/admin/wa/api/contacts', async () => ({
    ok: true,
    contacts: (await run(`SELECT c.wa_id, c.name, c.user_id, c.opted_in, c.opted_out, c.consent_source, c.last_inbound_at,
        (SELECT body FROM wa_messages m WHERE m.wa_id = c.wa_id ORDER BY m.created_at DESC LIMIT 1) AS last_body,
        (SELECT MAX(created_at) FROM wa_messages m WHERE m.wa_id = c.wa_id) AS last_at
      FROM wa_contacts c ORDER BY COALESCE(last_at, c.created_at) DESC LIMIT 200`)).rows,
  }));
  adm('get', '/admin/wa/api/messages', async (req) => {
    const waId = digits(req.query.wa_id);
    if (!waId) throw bad('wa_id requis.');
    const rows = (await run(`SELECT id, direction, type, body, media_id, status, error, created_at FROM wa_messages WHERE wa_id = ? ORDER BY created_at DESC LIMIT 100`, [waId])).rows;
    return { ok: true, messages: rows.reverse(), contact: await getContact(waId) };
  });
  adm('post', '/admin/wa/api/consent', async (req) => {
    const waId = digits(req.body && req.body.wa_id);
    if (!/^\d{8,15}$/.test(waId)) throw bad('Numéro invalide.');
    if (!req.body.attest) throw bad("Coche l'attestation : tu confirmes avoir l'accord de cette personne.");
    await setConsent(waId, { source: `admin:${trunc(String(req.body.note || 'attesté'), 80)}`, name: req.body.name ? trunc(String(req.body.name), 80) : null });
    return { ok: true };
  });
  adm('post', '/admin/wa/api/optout', async (req) => { await setOptOut(digits(req.body && req.body.wa_id)); return { ok: true }; });
  adm('post', '/admin/wa/api/send', async (req) => {
    const b = req.body || {};
    const out = await send(b.to, buildMessage(b), { group: !!b.group });
    return { ok: true, ...out };
  });
  adm('post', '/admin/wa/api/read', async (req) => ({ ok: true, result: await markRead(str(req.body && req.body.message_id, 300, 'message_id'), { typing: !!req.body.typing }) }));
  adm('post', '/admin/wa/api/upload', async (req) => {
    const b = req.body || {};
    const mime = str(b.mime, 100, 'Type MIME');
    const buf = Buffer.from(String(b.data || ''), 'base64');
    const out = await uploadMedia(buf, mime, b.filename ? str(b.filename, 200, 'Nom du fichier') : undefined);
    return { ok: true, id: out.id };
  });
  app.get('/admin/wa/media/:id', limitAdmin, adminAuth, async (req, res) => {
    try {
      if (!/^\d{5,30}$/.test(req.params.id)) return res.status(400).send('Bad id.');
      const m = await downloadMedia(req.params.id);
      res.set({ 'Content-Type': m.mime, 'Content-Security-Policy': "sandbox; default-src 'none'", 'Cache-Control': 'private, max-age=300' });
      res.send(m.buffer);
    } catch (e) { res.status(e.httpStatus || 500).send(e.message); }
  });
  app.get('/admin/wa/api/image', limitAdmin, adminAuth, async (req, res) => { // proxy pour QR / photo de profil (liste blanche d'hôtes Meta)
    try {
      const u = new URL(String(req.query.u || ''));
      const okHost = u.protocol === 'https:' && /(^|\.)(fbcdn\.net|whatsapp\.net|whatsapp\.com|facebook\.com)$/.test(u.hostname);
      if (!okHost) return res.status(400).send('Hôte refusé.');
      const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) return res.status(502).send('Image indisponible.');
      const type = String(r.headers.get('content-type') || '');
      if (!/^image\//.test(type)) return res.status(415).send('Pas une image.');
      res.set({ 'Content-Type': type, 'Content-Security-Policy': "sandbox; default-src 'none'", 'Cache-Control': 'private, max-age=300' });
      res.send(Buffer.from(await r.arrayBuffer()));
    } catch (e) { res.status(400).send('Requête invalide.'); }
  });

  // Modèles
  adm('get', '/admin/wa/api/templates', async () => ({ ok: true, templates: await listTemplates() }));
  adm('post', '/admin/wa/api/templates', async (req) => ({ ok: true, result: await createTemplate(templateFromInput(req.body || {})) }));
  adm('post', '/admin/wa/api/templates/presets', async () => {
    const results = [];
    for (const t of presetTemplates()) {
      try { const r = await createTemplate(t); results.push({ name: t.name, ok: true, status: r.status }); }
      catch (e) { results.push({ name: t.name, ok: false, error: e.message }); }
    }
    return { ok: true, results };
  });
  adm('post', '/admin/wa/api/templates/delete', async (req) => ({ ok: true, result: await deleteTemplate(str(req.body && req.body.name, 512, 'Nom')) }));

  // Profil professionnel
  adm('get', '/admin/wa/api/profile', async () => {
    const r = await graph('GET', `${cfg.phoneId}/whatsapp_business_profile`, { query: { fields: 'about,address,description,email,profile_picture_url,websites,vertical' } });
    return { ok: true, profile: (r.data && r.data[0]) || {}, verticals: VERTICALS };
  });
  adm('post', '/admin/wa/api/profile', async (req) => {
    const b = req.body || {};
    const json = { messaging_product: 'whatsapp' };
    if (b.about !== undefined) json.about = str(b.about, 139, 'À propos');
    if (b.description !== undefined) json.description = str(b.description, 512, 'Description', { required: false });
    if (b.address !== undefined) json.address = str(b.address, 256, 'Adresse', { required: false });
    if (b.email !== undefined) json.email = str(b.email, 128, 'E-mail', { required: false });
    if (b.vertical !== undefined) { if (!VERTICALS.includes(b.vertical)) throw bad('Secteur invalide.'); json.vertical = b.vertical; }
    if (b.websites !== undefined) {
      const w = [].concat(b.websites).map((x) => String(x).trim()).filter(Boolean);
      if (w.length > 2 || w.some((x) => !/^https?:\/\//i.test(x))) throw bad('Sites web : 2 maximum, commençant par http:// ou https://');
      json.websites = w;
    }
    if (b.picture && b.picture.data) {
      if (!cfg.appId) throw bad("Pour changer la photo, renseigne WHATSAPP_APP_ID (Paramètres de l'app > Général).");
      const buf = Buffer.from(String(b.picture.data), 'base64');
      const mime = String(b.picture.mime || 'image/jpeg');
      if (!/^image\/(jpeg|png)$/.test(mime)) throw bad('Photo : JPEG ou PNG.');
      const s = await graph('POST', `${cfg.appId}/uploads`, { query: { file_length: buf.length, file_type: mime, file_name: 'profile' } });
      const up = await graph('POST', s.id, { rawBody: buf, headers: { file_offset: '0' }, authScheme: 'OAuth', timeout: 60000 });
      json.profile_picture_handle = up.h;
    }
    return { ok: true, result: await graph('POST', `${cfg.phoneId}/whatsapp_business_profile`, { json }) };
  });

  // Liens wa.me / QR
  adm('get', '/admin/wa/api/qr', async () => {
    let r;
    try { r = await graph('GET', `${cfg.phoneId}/message_qrdls`, { query: { fields: 'code,prefilled_message,deep_link_url,qr_image_url.format(PNG)' } }); }
    catch { r = await graph('GET', `${cfg.phoneId}/message_qrdls`); }
    return { ok: true, codes: r.data || [], link: `https://wa.me/${cfg.businessNumber}` };
  });
  adm('post', '/admin/wa/api/qr', async (req) => ({ ok: true, qr: await graph('POST', `${cfg.phoneId}/message_qrdls`, { json: { prefilled_message: str(req.body && req.body.message, 140, 'Message pré-rempli'), generate_qr_image: 'PNG' } }) }));
  adm('post', '/admin/wa/api/qr/delete', async (req) => ({ ok: true, result: await graph('DELETE', `${cfg.phoneId}/message_qrdls/${encodeURIComponent(str(req.body && req.body.code, 40, 'Code'))}`) }));

  // Catalogue
  adm('get', '/admin/wa/api/commerce', async () => ({ ok: true, settings: ((await graph('GET', `${cfg.phoneId}/whatsapp_commerce_settings`)).data || [])[0] || {} }));
  adm('post', '/admin/wa/api/commerce', async (req) => ({ ok: true, result: await graph('POST', `${cfg.phoneId}/whatsapp_commerce_settings`, { json: { is_catalog_visible: !!req.body.catalog_visible, is_cart_enabled: !!req.body.cart_enabled } }) }));

  // Groupes (selon l'accès accordé par Meta)
  adm('get', '/admin/wa/api/groups', async () => { const r = await graph('GET', `${cfg.phoneId}/groups`); return { ok: true, groups: (r.data && r.data.groups) || [] }; });
  adm('post', '/admin/wa/api/groups', async (req) => ({ ok: true, result: await graph('POST', `${cfg.phoneId}/groups`, { json: { messaging_product: 'whatsapp', subject: str(req.body && req.body.subject, 128, 'Nom du groupe'), description: req.body.description ? str(req.body.description, 2048, 'Description') : undefined, join_approval_mode: req.body.approval ? 'approval_required' : 'auto_approve' } }) }));
  adm('get', '/admin/wa/api/groups/info', async (req) => ({ ok: true, group: await graph('GET', str(req.query.id, 80, 'Groupe'), { query: { fields: 'subject,description,creation_timestamp,suspended,total_participant_count,join_approval_mode' } }), invite: await graph('GET', `${str(req.query.id, 80, 'Groupe')}/invite_link`).catch(() => null) }));
  adm('post', '/admin/wa/api/groups/reset-invite', async (req) => ({ ok: true, result: await graph('POST', `${str(req.body && req.body.id, 80, 'Groupe')}/invite_link`, { json: { messaging_product: 'whatsapp' } }) }));
  adm('post', '/admin/wa/api/groups/delete', async (req) => ({ ok: true, result: await graph('DELETE', str(req.body && req.body.id, 80, 'Groupe'), { json: { messaging_product: 'whatsapp' } }) }));

  // Liens de dépannage historiques (ouverts depuis le navigateur du téléphone)
  adm('get', '/admin/wa-register', async () => ({ ok: true, result: await graph('POST', `${cfg.phoneId}/register`, { json: { messaging_product: 'whatsapp', pin: cfg.pin } }) }));
  adm('get', '/admin/wa-test', async () => {
    const out = await send(cfg.ownerNumber, B.template({ name: 'hello_world', lang: 'en_US' }), { skipGate: true });
    return { ok: true, to: cfg.ownerNumber, result: out };
  });

  return {
    ready, cfg, send, sendText, sendTemplate, sendOtp, markRead, buildMessage, handleWebhook, graph,
    uploadMedia, downloadMedia, listTemplates, createTemplate, deleteTemplate, presetTemplates,
    notifyUser, notifyTopupDecision, notifyReportReceived, TPL,
  };
}

module.exports = { create, WaError, B, buildMessage, TPL };
