'use strict';

/* ============================================================================
   TAKAMURA ELITE — index.js (v3)
   Accounts + email verification (6-digit code) + WALLET (recharge Money Fusion,
   preuve de paiement envoyée par l'utilisateur, validation manuelle par un admin)
   + reports + history + admin.

   Files: index.html, index.js, package.json only.
   All secrets come from environment variables (see the ENV block below).
   ============================================================================ */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

/* ================================ ENV ====================================== */
// Valeurs en dur, à la demande — seule BREVO_API_KEY reste en variable d'environnement.
const env = (k, d = '') => String(process.env[k] ?? d).trim();

const PORT = Number(env('PORT', '3000'));
const TRUST_PROXY = true;

const TURSO_DATABASE_URL = 'libsql://yh-yhrespon77.aws-us-east-1.turso.io';
const TURSO_AUTH_TOKEN = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODk2MTQyNTgsImlkIjoiMDFhMGFkM2EtMDAwMS03NGE3LWFjMmMtZDIzZDQzNzQwZDJmIiwia2lkIjoicTIzMHlLZ1lJRlYtakt2czZPTmttNkpMdk1PTGt1TzFQcm5wamdka3c4VSIsInJpZCI6ImNhY2YzZWU1LTM3ZWMtNGY5My05N2ZkLTQwMGVhODIwOGFhYyJ9.XCpmnB8zB0r_F7YHoUoJIcOHVhCCKAzWo9F2vUY45eGorwJuaV4QI--1DqhF-eOzq3djWsfnW0dYv5OjmIwMAg';

const BREVO_API_KEY = env('BREVO_API_KEY'); // ← seule valeur restée en env, comme demandé
const BREVO_SENDER_EMAIL = 'yhrespon@gmail.com'; // expéditeur vérifié dans Brevo
const ADMIN_EMAIL = 'takamura2026@gmail.com';
const ADMIN_PASSWORD = 'TAKAMURA2026';

// Recharge de portefeuille via Money Fusion — lien de paiement unique, fourni par l'admin.
// Le client paie sur ce lien (tous moyens acceptés par Money Fusion), puis envoie la capture
// d'écran du paiement. Un admin vérifie la preuve et approuve manuellement le crédit du solde.
const MONEY_FUSION_URL = 'https://my.moneyfusion.net/69baa0c5d64e43f8715d8bf8';
const WALLET_CURRENCY = env('WALLET_CURRENCY', 'FCFA');
// Vérification de numéro (API Baron0) — clé en dur comme le reste de la config ; elle reste côté serveur, jamais envoyée au navigateur.
const BANCHECK_API_BASE = 'https://baron0.com';
const BANCHECK_API_KEY = 'bk_v1_ggd2nwDLgDhNo6kF_lKz2hTdHxNuZbVJn-yKZDkwkE5EMQjHLxCoxJ_46QVv6Wi9vPb2p2cdr6YvhR1IcpUNEfugPZsWZnKN1_SQdY8LjFDN4rjj-OFmWKZNDc07OEiuXKMznAuXCeO4j6CAoJwSJ6_Zk4AF8xWN4Y3k8O_AqSxPo90u85nBdn_X9IZqHpufCBesz9axVaV5bmAdZ1e6rKck8oZBzeT4ronYvKVATs9Vw071YRAFfZjAnf9TqOrtRwHx1cnysrWPiKeWPHMDiiTYsdfnOzdQZdjWu3Xs1wu-KEoCZVst7q0_obwDbfbq9JRpoGyd_LVM9k_FO_mkSJlr_OeqDKEpENkRuNMIC6_7RuJV1m_CthsyyJD0trlmb6bd3cAddmaFfttJCObnBzqFWRG4yJXp-g3PKjqHprsb3DTuVwPvs5YO7JAR3AMXJ3BXv3-1Ja86-oHmjzGgIONf0nbcRfMVjes8rE0LevdwmxG8IWlTf1p7kvKpQkfRSzfQ6c70xMClx6NZHviKcRY9tbY4bIvf5dqgUQ4';
const CHECK_TIMEOUT_MS = 15000;
// Surveillance automatique des numéros ciblés par les signalements.
const WATCH_INTERVAL_MS = 15 * 60 * 1000; // revérification toutes les 15 min
const WATCH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // un numéro est suivi 7 jours après le dernier signalement (arrêt dès qu'il est BANNI)
const WATCH_DELAY_MS = 400; // pause entre deux appels API
const WATCH_REUSE_MS = 60 * 1000; // un numéro déjà vérifié il y a moins d'1 min n'est pas redemandé à l'API
const MIN_USABLE_BALANCE = 1000; // solde minimum pour pouvoir utiliser la plateforme (soumettre un signalement)
const MIN_TOPUP_AMOUNT = 100; // montant minimum d'une demande de recharge
const MAX_TOPUP_AMOUNT = 2000000; // garde-fou anti-erreur de saisie
const MAX_PROOF_BASE64_LEN = 7_000_000; // ~5 Mo d'image en base64

const missing = [];
if (!TURSO_DATABASE_URL) missing.push('TURSO_DATABASE_URL');
if (!TURSO_AUTH_TOKEN) missing.push('TURSO_AUTH_TOKEN');
if (!ADMIN_PASSWORD) missing.push('ADMIN_PASSWORD');
if (missing.length) {
  console.error(`[BOOT] Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}
if (ADMIN_PASSWORD.length < 12) {
  console.error('[BOOT] ADMIN_PASSWORD must be at least 12 characters.');
  process.exit(1);
}
if (!BREVO_API_KEY || !BREVO_SENDER_EMAIL) console.warn('[BOOT] BREVO_API_KEY / BREVO_SENDER_EMAIL missing: emails will fail.');

const { createClient } = require('@tursodatabase/serverless/compat');
const db = createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });

/* ============================== CONSTANTS ================================== */
const CODE_TTL_MS = 15 * 60 * 1000;
const CODE_COOLDOWN_MS = 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_REPORTS_PER_DAY = 20;
const RECONCILE_MIN_GAP_MS = 8000;

// Pays où Money Fusion permet d'envoyer de l'argent (agrégateur ivoirien SC Digital) :
// Côte d'Ivoire, Sénégal, Mali, Togo, Burkina Faso, Bénin — via Orange Money, MTN MoMo, Moov Money,
// Wave selon le pays, ainsi que carte bancaire. Affiché côté client pour information.
const MONEY_FUSION_COUNTRIES = [
  { code: 'CI', label: "Côte d'Ivoire" },
  { code: 'SN', label: 'Sénégal' },
  { code: 'ML', label: 'Mali' },
  { code: 'TG', label: 'Togo' },
  { code: 'BF', label: 'Burkina Faso' },
  { code: 'BJ', label: 'Bénin' },
];

const WHATSAPP_EMAILS = [
  'support@support.whatsapp.com',
  'support@whatsapp.com',
  'android@support.whatsapp.com',
  'smb@support.whatsapp.com',
  'accessibility@support.whatsapp.com',
];
const DEST_NOTES = {
  'support@support.whatsapp.com': 'Public address — General support',
  'support@whatsapp.com': 'Public address — Support',
  'android@support.whatsapp.com': 'Public address — Android',
  'smb@support.whatsapp.com': 'Public address — WhatsApp Business',
  'accessibility@support.whatsapp.com': 'Public address — Accessibility',
};
// Honnêteté : ces adresses sont des contacts publics couramment cités pour WhatsApp/Meta.
// Il ne s'agit PAS d'une API officielle de signalement, et rien ne garantit qu'une boîte
// mail donnée soit surveillée ou traitée par Meta. Ce disclaimer est renvoyé au front
// (config + réponse de /api/report) pour être affiché à l'utilisateur avant et après l'envoi.
const REPORT_DISCLAIMER = "Ce signalement est un e-mail envoyé à des adresses publiques associées au support WhatsApp/Meta. Ce n'est pas une API officielle de signalement, et rien ne garantit qu'une boîte mail est surveillée ou que le message sera traité. Pour un danger immédiat impliquant un mineur, contactez aussi les autorités locales.";

const CATEGORIES = ['Fraude / Arnaque', "Pédocriminalité / Exploitation d'enfants", 'Spam', 'Vente illégale', 'Autre'];
const SEVERITIES = ['Faible', 'Modérée', 'Élevée', 'Critique — mineurs impliqués'];

/* =============================== DATABASE ================================== */
async function ensureColumn(table, column, definition) {
  try { await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`); } catch (_) { /* exists */ }
}
async function tableColumns(table) {
  try {
    const r = await db.execute(`PRAGMA table_info(${table})`);
    return (r.rows || []).map((x) => String(x.name));
  } catch (_) { return []; }
}
async function quarantineLegacyUsers() {
  const cols = await tableColumns('users');
  if (!cols.length) return;
  const required = ['id', 'email', 'password_hash', 'created_at'];
  if (!required.filter((c) => !cols.includes(c)).length) return;
  const legacy = `users_legacy_${Date.now()}`;
  console.warn(`[DB] Legacy users table renamed to ${legacy}.`);
  await db.execute(`ALTER TABLE users RENAME TO ${legacy}`);
}

async function initDb() {
  await quarantineLegacyUsers();
  await db.execute(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    verified INTEGER NOT NULL DEFAULT 0,
    verification_code TEXT,
    verification_expires INTEGER,
    verification_attempts INTEGER NOT NULL DEFAULT 0,
    balance INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`);
  await ensureColumn('users', 'verified', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('users', 'verification_code', 'TEXT');
  await ensureColumn('users', 'verification_expires', 'INTEGER');
  await ensureColumn('users', 'verification_attempts', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('users', 'balance', 'INTEGER NOT NULL DEFAULT 0');

  await db.execute(`CREATE TABLE IF NOT EXISTS auth_tokens (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    case_id TEXT,
    category TEXT,
    severity TEXT,
    wa_number TEXT,
    message TEXT,
    created_at INTEGER NOT NULL,
    email_status TEXT
  )`);
  // Recharges de portefeuille (Money Fusion) : le client déclare un montant et joint la capture
  // d'écran du paiement (image encodée en base64, stockée telle quelle). Un admin approuve ou
  // rejette ; seule une approbation crédite le solde (voir /admin/topups/decision).
  await db.execute(`CREATE TABLE IF NOT EXISTS topups (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL,
    proof_data TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    admin_note TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  )`);

  // Historique des vérifications de numéro (résultat normalisé stocké en JSON).
  await db.execute(`CREATE TABLE IF NOT EXISTS checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    number TEXT NOT NULL,
    status TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);

  // Numéros ciblés par les signalements, suivis automatiquement (un seul enregistrement par numéro, chiffres seuls).
  await db.execute(`CREATE TABLE IF NOT EXISTS watched_numbers (
    number TEXT PRIMARY KEY,
    status TEXT,
    result TEXT,
    first_seen INTEGER NOT NULL,
    last_report_at INTEGER NOT NULL,
    checked_at INTEGER,
    changed_at INTEGER,
    check_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0
  )`);

  await ensureColumn('auth_tokens', 'user_id', 'INTEGER');
  await ensureColumn('auth_tokens', 'created_at', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('reports', 'user_id', 'INTEGER');
  await ensureColumn('reports', 'case_id', 'TEXT');
  await ensureColumn('reports', 'category', 'TEXT');
  await ensureColumn('reports', 'severity', 'TEXT');
  await ensureColumn('reports', 'wa_number', 'TEXT');
  await ensureColumn('reports', 'message', 'TEXT');
  await ensureColumn('reports', 'created_at', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('reports', 'email_status', 'TEXT');

  for (const sql of [
    `CREATE INDEX IF NOT EXISTS idx_reports_user ON reports(user_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_watched_due ON watched_numbers(status, last_report_at)`,
    `CREATE INDEX IF NOT EXISTS idx_checks_user ON checks(user_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_topups_user ON topups(user_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_topups_status ON topups(status, created_at)`,
  ]) {
    try { await db.execute(sql); } catch (e) { console.warn('[DB] Index skipped:', e.message); }
  }
  await db.execute({ sql: `DELETE FROM auth_tokens WHERE created_at < ?`, args: [Date.now() - TOKEN_TTL_MS] });
  console.log('[DB] Tables ready.');
}

/* ================================ HELPERS ================================== */
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
function cleanLine(v, max) { return String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max); }
function cleanText(v, max) { return String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max); }
// Numéro (chiffres seuls) d'une cible WhatsApp : « +237 6 12 34 56 78 », wa.me/237…, api.whatsapp.com/send?phone=237… ; '' si la cible n'en contient pas (lien de groupe).
function targetDigits(t) {
  const s = String(t || '').trim();
  if (/^\+?[0-9 ()\-]{6,20}$/.test(s)) return s.replace(/\D/g, '');
  const m = s.match(/^https?:\/\/wa\.me\/\+?(\d{6,20})/i) || s.match(/^https?:\/\/api\.whatsapp\.com\/send\/?\?(?:[^#]*&)?phone=\+?(\d{6,20})/i);
  return m ? m[1] : '';
}
// Motif par défaut : contenu de yh.txt (racine du projet), relu à chaque envoi. {{NUMERO}} est remplacé par le numéro cible ;
// si la cible n'a pas de numéro (lien de groupe), le lien api.whatsapp.com de yh.txt est remplacé par la cible telle quelle.
function defaultMotif(waNumber) {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'yh.txt'), 'utf8');
    const digits = targetDigits(waNumber);
    const txt = digits
      ? raw.replace(/\{\{NUMERO\}\}/g, digits)
      : raw.replace(/https?:\/\/api\.whatsapp\.com\/send\?phone=\{\{NUMERO\}\}/g, () => String(waNumber || '')).replace(/\{\{NUMERO\}\}/g, '');
    return cleanText(txt, 5000);
  } catch (e) { console.error('[yh.txt]', e.message); return ''; }
}
const rowsAffected = (r) => Number((r && (r.rowsAffected ?? r.rows_affected)) || 0);
async function countRows(sql, args) {
  const r = await db.execute({ sql, args });
  return Number(r.rows[0]?.c || 0);
}
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    let h = hits.get(req.ip);
    if (!h || h.reset <= now) { h = { count: 0, reset: now + windowMs }; hits.set(req.ip, h); }
    h.count++;
    if (h.count > max) {
      res.set('Retry-After', String(Math.ceil((h.reset - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    next();
  };
}
const MIN = 60 * 1000;
const limitGlobal = rateLimit({ windowMs: 15 * MIN, max: 900 });
const limitRegister = rateLimit({ windowMs: 60 * MIN, max: 10 });
const limitLogin = rateLimit({ windowMs: 15 * MIN, max: 20 });
const limitVerify = rateLimit({ windowMs: 15 * MIN, max: 20 });
const limitResend = rateLimit({ windowMs: 15 * MIN, max: 5 });
const limitPayStart = rateLimit({ windowMs: 60 * MIN, max: 12 });
const limitPayStatus = rateLimit({ windowMs: 15 * MIN, max: 400 });
const limitReport = rateLimit({ windowMs: 60 * MIN, max: 20 });
const limitAdmin = rateLimit({ windowMs: 15 * MIN, max: 120 });

/* --------------------------------- Passwords -------------------------------- */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 64)).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
async function verifyPassword(password, stored) {
  try {
    const [algo, salt, hash] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const check = await scrypt(password, salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return expected.length === check.length && crypto.timingSafeEqual(expected, check);
  } catch { return false; }
}
const DUMMY_HASH = (() => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync('dummy-password', salt, 64).toString('hex')}`;
})();

/* ------------------------------ Verification codes -------------------------- */
const generateCode = () => String(crypto.randomInt(100000, 1000000));
function codeIssuedRecently(user) {
  const exp = Number(user.verification_expires);
  return !!exp && (exp - CODE_TTL_MS) > Date.now() - CODE_COOLDOWN_MS;
}
async function issueVerificationCode(userId, email) {
  const code = generateCode();
  await db.execute({
    sql: `UPDATE users SET verification_code = ?, verification_expires = ?, verification_attempts = 0 WHERE id = ?`,
    args: [code, Date.now() + CODE_TTL_MS, userId],
  });
  sendVerificationEmail(email, code).catch((e) => console.error('[mail verify]', e.message));
}

/* ------------------------------- Auth tokens -------------------------------- */
async function getUserFromToken(req) {
  const token = req.header('X-User-Token') || '';
  if (!token || token.length > 200) return null;
  const r = await db.execute({
    sql: `SELECT u.id, u.email, u.verified, u.created_at
          FROM auth_tokens t JOIN users u ON u.id = t.user_id
          WHERE t.token = ? AND t.created_at > ?`,
    args: [sha256(token), Date.now() - TOKEN_TTL_MS],
  });
  return (r.rows && r.rows[0]) || null;
}
async function issueToken(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  await db.execute({
    sql: `INSERT INTO auth_tokens (token, user_id, created_at) VALUES (?, ?, ?)`,
    args: [sha256(token), userId, Date.now()],
  });
  return token;
}
async function getBalance(userId) {
  const r = await db.execute({ sql: `SELECT balance FROM users WHERE id = ?`, args: [userId] });
  return Number((r.rows && r.rows[0] && r.rows[0].balance) || 0);
}

/* ================================== MAIL =================================== */
const MAIL_FONT = '-apple-system,Segoe UI,Helvetica,Arial,sans-serif';
// Envoi via l'API Brevo : 3 tentatives sur erreur réseau / 429 / 5xx, message d'erreur détaillé dans les logs.
async function sendViaBrevo({ to, subject, text, html, replyTo, tags }) {
  if (!BREVO_API_KEY || !BREVO_SENDER_EMAIL) throw new Error('Email provider not configured');
  const payload = { sender: { name: 'Takamura Elite', email: BREVO_SENDER_EMAIL }, to: [{ email: to }], subject, textContent: text };
  if (html) payload.htmlContent = html;
  if (replyTo) payload.replyTo = { email: replyTo };
  if (tags && tags.length) payload.tags = tags;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, attempt * 700));
    try {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) return res.json().catch(() => ({}));
      const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
      lastErr = new Error(`Brevo ${res.status}: ${detail}`);
      if (res.status !== 429 && res.status < 500) throw lastErr; // erreur définitive (clé, expéditeur, adresse)
    } catch (e) {
      if (e === lastErr) throw e;
      lastErr = e; // réseau / délai dépassé : on réessaie
    }
  }
  throw lastErr;
}
const mailer = { sendMail: sendViaBrevo };

// Gabarit commun des e-mails HTML (les valeurs doivent être échappées par l'appelant via esc()).
function emailLayout({ title, intro, bodyHtml, footer }) {
  const f = (size, color, extra = '') => `font:${size} ${MAIL_FONT};color:${color};${extra}`;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0b">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0a0a0b"><tr><td align="center" style="padding:28px 14px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#111113;border:1px solid #26262b;border-radius:14px">
<tr><td style="padding:28px 28px 6px;${f('600 12px', '#c9a66b', 'letter-spacing:.24em')}">TAKAMURA ELITE</td></tr>
<tr><td style="padding:6px 28px 0;${f('600 21px/1.3', '#ece8df')}">${esc(title)}</td></tr>
${intro ? `<tr><td style="padding:8px 28px 0;${f('14px/1.6', '#b9b6ae')}">${esc(intro)}</td></tr>` : ''}
<tr><td style="padding:18px 28px 8px;${f('14px/1.6', '#ece8df')}">${bodyHtml}</td></tr>
<tr><td style="padding:16px 28px 24px;border-top:1px solid #26262b;${f('12px/1.6', '#8b8a86')}">${footer || 'Takamura Elite'}</td></tr>
</table></td></tr></table></body></html>`;
}
const emailCode = (code) => `<div style="display:inline-block;margin:4px 0;padding:14px 22px;border:1px solid rgba(201,166,107,.35);border-radius:10px;background:#16161a;font:600 30px ${MAIL_FONT};letter-spacing:.3em;color:#e0c48a">${esc(code)}</div>`;
const emailRows = (rows) => `<table role="presentation" width="100%" cellspacing="0" cellpadding="0">${rows.map(([k, v]) => `<tr><td style="padding:7px 0;font:13px ${MAIL_FONT};color:#8b8a86">${esc(k)}</td><td align="right" style="padding:7px 0;font:600 14px ${MAIL_FONT};color:#ece8df">${esc(v)}</td></tr>`).join('')}</table>`;
const emailNote = (t) => `<p style="margin:14px 0 0;font:13px/1.6 ${MAIL_FONT};color:#b9b6ae">${esc(t)}</p>`;

async function sendVerificationEmail(email, code) {
  const minutes = Math.round(CODE_TTL_MS / 60000);
  const subject = `Takamura Elite — ${code} is your verification code`;
  const text =
    `Your Takamura Elite verification code / Votre code de vérification :\n\n    ${code}\n\n` +
    `Valid for ${minutes} minutes / Valable ${minutes} minutes.\n` +
    `If you did not create this account, ignore this email.\n\n— Takamura Elite`;
  const html = emailLayout({
    title: 'Votre code de vérification',
    intro: `Your verification code · Valable ${minutes} minutes.`,
    bodyHtml: emailCode(code) + emailNote("Si vous n'êtes pas à l'origine de cette inscription, ignorez cet e-mail. · If you did not create this account, ignore this email."),
  });
  return mailer.sendMail({ to: email, subject, text, html, tags: ['verification'] });
}
async function sendWhatsAppReport({ caseId, category, severity, waNumber, message, destination }) {
  const { subject, body } = reportEmailContent({ caseId, category, severity, waNumber, message });
  return mailer.sendMail({ to: destination, subject, text: body });
}
function reportEmailContent({ caseId, category, severity, waNumber, message }) {
  const subject = `Signalement WhatsApp — ${category} — ${waNumber}`;
  let body = `${caseId}\n`;
  body += `Catégorie : ${category}\nGravité : ${severity}\nNuméro / lien WhatsApp signalé : ${waNumber}\n\n`;
  if (message) body += `Message litigieux (copié par le déclarant) :\n${message}\n\n`;
  body += `Merci d'examiner ce compte pour violation des conditions d'utilisation WhatsApp.\n`;
  return { subject, body };
}
async function sendTopupDecisionEmail(email, topup, decision, newBalance) {
  try {
    const amount = `${money(topup.amount)} ${WALLET_CURRENCY}`;
    const approved = decision === 'approved';
    const subject = `Takamura Elite — Recharge de ${amount} ${approved ? 'approuvée' : 'refusée'}`;
    const text = approved
      ? `Votre recharge a été vérifiée et approuvée par un administrateur.\n\nMontant crédité : ${amount}\nNouveau solde : ${money(newBalance)} ${WALLET_CURRENCY}\n\n— Takamura Elite`
      : `Votre demande de recharge de ${amount} n'a pas pu être validée (preuve de paiement introuvable ou incorrecte). Vous pouvez soumettre une nouvelle demande avec une capture d'écran valide.\n\n— Takamura Elite`;
    const html = emailLayout({
      title: approved ? 'Recharge approuvée' : 'Recharge refusée',
      intro: approved ? 'Votre paiement a été vérifié par un administrateur.' : "Votre demande n'a pas pu être validée.",
      bodyHtml: approved
        ? emailRows([['Montant crédité', amount], ['Nouveau solde', `${money(newBalance)} ${WALLET_CURRENCY}`]])
        : emailRows([['Montant demandé', amount]]) + emailNote("La preuve de paiement est introuvable ou incorrecte. Vous pouvez soumettre une nouvelle demande avec une capture d'écran valide."),
    });
    await mailer.sendMail({ to: email, subject, text, html, tags: ['topup'] });
  } catch (e) { console.error('[MAIL topup]', e.message); }
}
async function sendAdminTopupNotice(email, amount) {
  if (!ADMIN_EMAIL) return;
  try {
    const amt = `${money(amount)} ${WALLET_CURRENCY}`;
    await mailer.sendMail({
      to: ADMIN_EMAIL,
      subject: `[Takamura] Nouvelle demande de recharge — ${amt}`,
      text: `Compte : ${email}\nMontant déclaré : ${amt}\n\nÀ vérifier et approuver dans /admin (onglet Recharges).`,
      html: emailLayout({
        title: 'Nouvelle demande de recharge',
        bodyHtml: emailRows([['Compte', email], ['Montant déclaré', amt]]) + emailNote('À vérifier et approuver dans /admin (onglet Recharges).'),
      }),
      tags: ['admin-topup'],
    });
  } catch (e) { console.error('[MAIL admin topup]', e.message); }
}

/* ============================== WALLET / TOPUPS ============================= */
const getTopup = async (id) => {
  const r = await db.execute({ sql: `SELECT * FROM topups WHERE id = ?`, args: [id] });
  return (r.rows && r.rows[0]) || null;
};
function publicTopup(t) {
  return {
    id: t.id, status: t.status, amount: Number(t.amount), currency: t.currency,
    createdAt: Number(t.created_at), decidedAt: t.decided_at ? Number(t.decided_at) : null,
  };
}

/* ================================== APP ==================================== */
const app = express();
app.disable('x-powered-by');
if (TRUST_PROXY) app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
  next();
});
// La preuve de paiement (capture d'écran encodée en base64) ne transite que sur /api/topup/request,
// qui a donc besoin d'une limite plus large ; toutes les autres routes gardent une limite stricte.
app.use((req, res, next) => {
  const limit = req.path === '/api/topup/request' ? '7mb' : '100kb';
  express.json({ limit, verify: (r, _res, buf) => { r.rawBody = buf; } })(req, res, next);
});
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use('/api', limitGlobal);

// Only index.html is served (never express.static(__dirname): index.js must not be downloadable).
const INDEX_HTML_SRC = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
app.get(['/', '/index.html'], (_req, res) => {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.set({
    'Content-Security-Policy':
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}' https://fonts.googleapis.com; ` +
      `style-src-elem 'nonce-${nonce}' https://fonts.googleapis.com; style-src-attr 'unsafe-inline'; ` +
      `font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; ` +
      `base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'Cache-Control': 'no-store',
  });
  res.type('html').send(INDEX_HTML_SRC.replaceAll('{{NONCE}}', nonce));
});

// Motif prérempli (yh.txt, numéro = cible) : le front l'insère dans le champ « Preuve », l'utilisateur peut le modifier ou compléter.
app.get('/api/motif', (req, res) => {
  res.set('Cache-Control', 'no-store').json({ motif: defaultMotif(cleanLine(req.query?.target, 200)) });
});

app.get('/api/config', (_req, res) => {
  res.json({
    moneyFusionUrl: MONEY_FUSION_URL,
    currency: WALLET_CURRENCY,
    minUsableBalance: MIN_USABLE_BALANCE,
    minTopupAmount: MIN_TOPUP_AMOUNT,
    maxTopupAmount: MAX_TOPUP_AMOUNT,
    moneyFusionCountries: MONEY_FUSION_COUNTRIES,
    destinations: WHATSAPP_EMAILS.map((email) => ({ email, note: DEST_NOTES[email] || '' })),
    categories: CATEGORIES,
    severities: SEVERITIES,
    codeTtlMinutes: Math.round(CODE_TTL_MS / 60000),
    reportDisclaimer: REPORT_DISCLAIMER,
  });
});

/* ------------------------------------ AUTH ---------------------------------- */
app.post('/api/auth/register', limitRegister, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password too short (8 characters minimum).' });
    if (password.length > 128) return res.status(400).json({ error: 'Password too long (128 characters maximum).' });

    const existing = await db.execute({ sql: `SELECT id, verified, verification_expires FROM users WHERE email = ?`, args: [email] });
    if (existing.rows.length) {
      const u = existing.rows[0];
      if (u.verified) return res.status(409).json({ error: 'This email is already in use.' });
      await db.execute({ sql: `UPDATE users SET password_hash = ? WHERE id = ?`, args: [await hashPassword(password), u.id] });
      if (!codeIssuedRecently(u)) await issueVerificationCode(u.id, email);
      return res.json({ needsVerification: true, email });
    }
    const now = Date.now();
    const code = generateCode();
    await db.execute({
      sql: `INSERT INTO users (email, password_hash, verified, verification_code, verification_expires, verification_attempts, created_at)
            VALUES (?, ?, 0, ?, ?, 0, ?)`,
      args: [email, await hashPassword(password), code, now + CODE_TTL_MS, now],
    });
    sendVerificationEmail(email, code).catch((e) => console.error('[mail verify]', e.message));
    res.json({ needsVerification: true, email });
  } catch (e) {
    console.error('[register]', e.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/auth/verify', limitVerify, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const code = String(req.body?.code || '').trim();
    if (!email || !code) return res.status(400).json({ error: 'Email and code are required.' });
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Incorrect code.' });

    await db.execute({ sql: `UPDATE users SET verification_attempts = verification_attempts + 1 WHERE email = ? AND verified = 0`, args: [email] });
    const r = await db.execute({
      sql: `SELECT id, email, verified, verification_code, verification_expires, verification_attempts FROM users WHERE email = ?`,
      args: [email],
    });
    const user = r.rows && r.rows[0];
    if (!user || user.verified) return res.status(400).json({ error: 'Incorrect or expired code.' });
    if (Number(user.verification_attempts) > MAX_CODE_ATTEMPTS) return res.status(429).json({ error: 'Too many attempts. Request a new code.' });
    if (!user.verification_expires || Date.now() > Number(user.verification_expires)) return res.status(400).json({ error: 'Code expired. Request a new code.' });
    if (!user.verification_code || !safeEqual(user.verification_code, code)) return res.status(400).json({ error: 'Incorrect code.' });

    await db.execute({
      sql: `UPDATE users SET verified = 1, verification_code = NULL, verification_expires = NULL, verification_attempts = 0 WHERE id = ?`,
      args: [user.id],
    });
    const token = await issueToken(user.id);
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (e) {
    console.error('[verify]', e.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/auth/resend', limitResend, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email is required.' });
    const r = await db.execute({ sql: `SELECT id, verified, verification_expires FROM users WHERE email = ?`, args: [email] });
    const user = r.rows && r.rows[0];
    if (user && !user.verified && !codeIssuedRecently(user)) await issueVerificationCode(user.id, email);
    res.json({ ok: true });
  } catch (e) {
    console.error('[resend]', e.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/auth/login', limitLogin, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    if (password.length > 128) return res.status(401).json({ error: 'Incorrect email or password.' });
    const r = await db.execute({ sql: `SELECT id, email, password_hash, verified, verification_expires FROM users WHERE email = ?`, args: [email] });
    const user = r.rows && r.rows[0];
    const passwordOk = await verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !passwordOk) return res.status(401).json({ error: 'Incorrect email or password.' });
    if (!user.verified) {
      if (!codeIssuedRecently(user)) await issueVerificationCode(user.id, email);
      return res.status(403).json({ error: 'Account not verified. A verification code has been sent.', needsVerification: true, email });
    }
    const token = await issueToken(user.id);
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (e) {
    console.error('[login]', e.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const token = req.header('X-User-Token') || '';
    if (token) await db.execute({ sql: `DELETE FROM auth_tokens WHERE token = ?`, args: [sha256(token)] });
    res.json({ ok: true });
  } catch { res.json({ ok: true }); }
});

app.get('/api/me', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Not authenticated.' });
    const balance = await getBalance(user.id);
    const reports = await countRows(`SELECT COUNT(*) AS c FROM reports WHERE user_id = ?`, [user.id]);
    const r = await db.execute({
      sql: `SELECT * FROM topups WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
      args: [user.id],
    });
    const pendingTopup = r.rows[0] ? publicTopup(r.rows[0]) : null;
    res.json({
      user: { id: user.id, email: user.email, createdAt: Number(user.created_at) },
      balance,
      hasAccess: balance >= MIN_USABLE_BALANCE,
      minUsableBalance: MIN_USABLE_BALANCE,
      pending: !!pendingTopup,
      pendingTopup,
      reports,
    });
  } catch (e) {
    console.error('[me]', e.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

/* ----------------------------------- WALLET ---------------------------------- */
// L'utilisateur paie de lui-même sur le lien Money Fusion (montant libre), puis déclare le
// montant payé et joint la capture d'écran. Rien n'est crédité automatiquement : seule une
// approbation admin (voir /admin/topups/decision) crédite le solde. Une seule recharge en
// attente à la fois par compte, pour garder la file d'admin lisible.
app.post('/api/topup/request', limitPayStart, async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Veuillez vous connecter.' });
    if (!user.verified) return res.status(403).json({ error: 'Compte non vérifié.' });

    const amount = Math.round(Number(req.body?.amount));
    if (!Number.isFinite(amount) || amount < MIN_TOPUP_AMOUNT || amount > MAX_TOPUP_AMOUNT) {
      return res.status(400).json({ error: `Montant invalide (minimum ${money(MIN_TOPUP_AMOUNT)} ${WALLET_CURRENCY}).` });
    }
    const proof = String(req.body?.proofBase64 || '');
    if (!proof || proof.length > MAX_PROOF_BASE64_LEN) return res.status(400).json({ error: 'Capture de paiement manquante ou trop volumineuse (5 Mo max).' });
    if (!/^data:image\/(png|jpe?g|webp);base64,[a-zA-Z0-9+/=]+$/.test(proof)) {
      return res.status(400).json({ error: 'Format de capture invalide (PNG, JPG ou WEBP uniquement).' });
    }

    const existing = await countRows(`SELECT COUNT(*) AS c FROM topups WHERE user_id = ? AND status = 'pending'`, [user.id]);
    if (existing > 0) return res.status(409).json({ error: 'Vous avez déjà une recharge en attente de vérification.' });

    const id = crypto.randomUUID();
    const now = Date.now();
    await db.execute({
      sql: `INSERT INTO topups (id, user_id, amount, currency, proof_data, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      args: [id, user.id, amount, WALLET_CURRENCY, proof, now],
    });
    sendAdminTopupNotice(user.email, amount).catch(() => {});
    res.json({ topup: publicTopup(await getTopup(id)) });
  } catch (e) {
    console.error('[topup/request]', e.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.get('/api/topup/mine', limitPayStatus, async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Not authenticated.' });
    const r = await db.execute({
      sql: `SELECT id, amount, currency, status, created_at, decided_at FROM topups WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
      args: [user.id],
    });
    res.json({ topups: r.rows.map(publicTopup) });
  } catch (e) {
    console.error('[topup/mine]', e.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

/* ---------------------------------- REPORTS --------------------------------- */
const WA_TARGET_RE = /^(\+?[0-9 ()\-]{6,20}|https?:\/\/(wa\.me|chat\.whatsapp\.com|api\.whatsapp\.com)\/\S{1,150})$/i;
const newCaseId = () => {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `TKM-${d}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
};

app.post('/api/report', limitReport, async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Not authenticated.' });
    const balance = await getBalance(user.id);
    if (balance < MIN_USABLE_BALANCE) return res.status(403).json({ error: `Solde insuffisant. Rechargez au moins ${money(MIN_USABLE_BALANCE)} ${WALLET_CURRENCY} pour utiliser la plateforme.` });

    const category = String(req.body?.category || '');
    const severity = String(req.body?.severity || 'Modérée');
    const waNumber = cleanLine(req.body?.waNumber, 200);
    const message = cleanText(req.body?.message, 5000) || defaultMotif(waNumber); // champ vide → motif automatique (yh.txt)
    if (!category || !waNumber) return res.status(400).json({ error: 'Category and target are required.' });
    if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category.' });
    if (!SEVERITIES.includes(severity)) return res.status(400).json({ error: 'Invalid severity.' });
    if (!WA_TARGET_RE.test(waNumber)) return res.status(400).json({ error: 'Invalid WhatsApp number or link.' });

    const sentToday = await countRows(`SELECT COUNT(*) AS c FROM reports WHERE user_id = ? AND created_at > ?`, [user.id, Date.now() - 24 * 60 * 60 * 1000]);
    if (sentToday >= MAX_REPORTS_PER_DAY) return res.status(429).json({ error: 'Daily report limit reached.' });

    const requested = Array.isArray(req.body?.destinations) ? req.body.destinations : [];
    const dests = requested.length ? [...new Set(requested.filter((d) => WHATSAPP_EMAILS.includes(d)))] : WHATSAPP_EMAILS;
    if (!dests.length) return res.status(400).json({ error: 'No valid destination selected.' });
    const mode = req.body?.mode === 'manual' ? 'manual' : 'auto';

    const caseId = newCaseId();
    const { subject, body } = reportEmailContent({ caseId, category, severity, waNumber, message });

    // Mode « stream » : le front lit les étapes RÉELLES de l'envoi (une ligne JSON par événement) pour sa barre de progression.
    const stream = mode === 'auto' && String(req.headers.accept || '').includes('application/x-ndjson');
    const emit = (o) => { if (stream && !res.destroyed && !res.writableEnded) res.write(JSON.stringify(o) + '\n'); };
    if (stream) {
      res.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      emit({ t: 'start', caseId, total: dests.length });
    }

    let ok = 0;
    if (mode === 'auto') {
      let finished = 0;
      const results = await Promise.allSettled(dests.map((d) => sendWhatsAppReport({ caseId, category, severity, waNumber, message, destination: d }).then(
        (v) => { emit({ t: 'step', dest: d, ok: true, done: ++finished, total: dests.length }); return v; },
        (e) => { emit({ t: 'step', dest: d, ok: false, done: ++finished, total: dests.length }); throw e; },
      )));
      results.forEach((r, i) => { if (r.status === 'rejected') console.error('[report mail]', dests[i], r.reason && r.reason.message); });
      ok = results.filter((r) => r.status === 'fulfilled').length;
    }
    // mode === 'manual': rien n'est envoyé côté serveur — le front ouvre l'appli mail de
    // l'utilisateur (mailto:) avec le sujet/corps ci-dessous, pour un envoi depuis sa vraie adresse.

    emit({ t: 'saving' });
    await db.execute({
      sql: `INSERT INTO reports (user_id, case_id, category, severity, wa_number, message, created_at, email_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [user.id, caseId, category, severity, waNumber, message, Date.now(), mode === 'manual' ? `manual/${dests.length}` : `${ok}/${dests.length}`],
    });
    // Statut du numéro ciblé : enregistré dans la surveillance (revérifié toutes les 15 min) et vérifié tout de suite.
    let check = null;
    const digits = mode === 'manual' || ok > 0 ? targetDigits(waNumber) : null;
    if (digits) {
      emit({ t: 'checking' });
      try {
        const w = await watchTarget(digits);
        check = { status: w.result.status, banType: w.result.banType, violation: w.result.violation, checkedAt: w.checkedAt };
      } catch (e) {
        console.error('[report check]', e.message);
        check = { status: 'error' }; // la surveillance réessaiera au prochain cycle
      }
      emit({ t: 'check', status: check.status });
    }
    // to/subject/body renvoyés dans tous les cas : après l'envoi auto (étape 1), le front ouvre aussi
    // l'appli mail (étape 2) avec le même contenu, pas seulement en mode manuel.
    const payload = { mode, sent: ok, total: dests.length, caseId, disclaimer: REPORT_DISCLAIMER, to: dests, subject, body, check };
    if (stream) { emit({ t: 'done', ...payload }); return res.end(); }
    res.json(payload);
  } catch (e) {
    console.error('[report]', e.message);
    if (res.headersSent) { // flux déjà ouvert : l'erreur voyage dans le flux
      try { if (!res.writableEnded) res.write(JSON.stringify({ t: 'error', error: 'Something went wrong. Please try again.' }) + '\n'); } catch {}
      return res.end();
    }
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.get('/api/reports', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Not authenticated.' });
    const r = await db.execute({
      sql: `SELECT case_id, category, severity, wa_number, created_at, email_status FROM reports WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`,
      args: [user.id],
    });
    const nums = [...new Set(r.rows.map((x) => targetDigits(x.wa_number)).filter(Boolean))];
    const watch = new Map();
    if (nums.length) {
      const w = await db.execute({ sql: `SELECT number, status, result, checked_at, changed_at FROM watched_numbers WHERE number IN (${nums.map(() => '?').join(',')})`, args: nums });
      for (const row of w.rows) {
        let d = {}; try { d = JSON.parse(row.result || '{}'); } catch (_) { /* ignoré */ }
        watch.set(row.number, { status: row.status || null, banType: d.banType || null, violation: d.violation || null, checkedAt: row.checked_at ? Number(row.checked_at) : null, changedAt: row.changed_at ? Number(row.changed_at) : null });
      }
    }
    res.json({
      reports: r.rows.map((x) => {
        const raw = String(x.email_status || '0/0');
        const manual = raw.startsWith('manual');
        const [ok, total] = raw.replace('manual/', '').split('/').map(Number);
        return {
          caseId: x.case_id, createdAt: Number(x.created_at), category: x.category, severity: x.severity,
          target: x.wa_number, status: manual ? 'manual' : ok > 0 ? 'sent' : 'failed', delivered: ok || 0, total: total || 0, check: watch.get(targetDigits(x.wa_number)) || null,
        };
      }),
    });
  } catch (e) {
    console.error('[reports]', e.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

/* ----------------------------------- ADMIN ---------------------------------- */
function adminAuth(req, res, next) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) {
    const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    const user = i >= 0 ? decoded.slice(0, i) : '';
    const pass = i >= 0 ? decoded.slice(i + 1) : '';
    const userOk = !ADMIN_EMAIL || safeEqual(sha256(user.toLowerCase()), sha256(ADMIN_EMAIL.toLowerCase()));
    const passOk = safeEqual(sha256(pass), sha256(ADMIN_PASSWORD));
    if (userOk && passOk) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Takamura Admin", charset="UTF-8"');
  res.status(401).send('Unauthorized.');
}
function requireAdminXhr(req, res, next) {
  if (req.get('X-Requested-With') !== 'takamura-admin') return res.status(403).json({ error: 'Request refused.' });
  next();
}
const fmtDate = (ms) => (ms ? new Date(Number(ms)).toLocaleString('en-GB', { timeZone: 'Africa/Douala', dateStyle: 'medium', timeStyle: 'short' }) : '—');
const money = (n) => Number(n || 0).toLocaleString('en-US');

app.get('/admin', limitAdmin, adminAuth, async (_req, res) => {
  try {
    const [u, pending, decided, r, stats] = await Promise.all([
      db.execute(`SELECT id, email, verified, balance, created_at FROM users ORDER BY created_at DESC LIMIT 200`),
      db.execute(`SELECT t.id, t.amount, t.currency, t.proof_data, t.created_at, u.email
                  FROM topups t LEFT JOIN users u ON u.id = t.user_id WHERE t.status = 'pending' ORDER BY t.created_at ASC LIMIT 100`),
      db.execute(`SELECT t.id, t.amount, t.currency, t.status, t.created_at, t.decided_at, u.email
                  FROM topups t LEFT JOIN users u ON u.id = t.user_id WHERE t.status != 'pending' ORDER BY t.decided_at DESC LIMIT 150`),
      db.execute(`SELECT r.case_id, r.category, r.severity, r.wa_number, r.message, r.created_at, r.email_status, u.email
                  FROM reports r LEFT JOIN users u ON u.id = r.user_id ORDER BY r.created_at DESC LIMIT 200`),
      Promise.all([
        countRows(`SELECT COUNT(*) AS c FROM users`, []),
        countRows(`SELECT COUNT(*) AS c FROM users WHERE balance >= ?`, [MIN_USABLE_BALANCE]),
        countRows(`SELECT COUNT(*) AS c FROM topups WHERE status = 'pending'`, []),
        countRows(`SELECT COUNT(*) AS c FROM reports`, []),
        db.execute(`SELECT COALESCE(SUM(amount),0) AS c FROM topups WHERE status = 'approved'`).then((x) => Number(x.rows[0].c || 0)),
      ]),
    ]);
    const [totalUsers, activeWallets, pendingTopups, totalReports, totalCredited] = stats;

    const nonce = crypto.randomBytes(16).toString('base64');
    res.set({
      'Content-Security-Policy':
        `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      'Cache-Control': 'no-store',
    });

    const badge = (s) => `<span class="b b-${esc(s)}">${esc(s)}</span>`;
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Takamura Admin</title>
<style>
:root{color-scheme:dark;--bg:#0a0a0b;--s:#111113;--s2:#16161a;--bd:rgba(255,255,255,.08);--tx:#ece8df;--mu:#8b8a86;--ac:#c9a66b;--ok:#6fbf8e;--er:#d9736b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.5 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;padding:24px;max-width:1280px;margin-inline:auto}
header{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:22px}
h1{font-size:13px;letter-spacing:.24em;color:var(--ac);margin:0;font-weight:600}
nav{display:flex;gap:4px;background:var(--s);border:1px solid var(--bd);border-radius:10px;padding:4px;flex-wrap:wrap}
nav button{background:none;border:0;color:var(--mu);padding:7px 14px;border-radius:7px;font:inherit;cursor:pointer}
nav button[aria-selected=true]{background:var(--s2);color:var(--tx)}nav button:focus-visible,.act:focus-visible{outline:2px solid var(--ac);outline-offset:2px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:22px}
.card{background:var(--s);border:1px solid var(--bd);border-radius:12px;padding:16px 18px}
.card small{display:block;color:var(--mu);font-size:11px;letter-spacing:.14em;text-transform:uppercase;margin-bottom:8px}.card strong{font-size:26px;font-weight:600;letter-spacing:-.02em}
.scroll{overflow-x:auto;border:1px solid var(--bd);border-radius:12px;background:var(--s)}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:10px 14px;text-align:left;border-bottom:1px solid var(--bd);vertical-align:top;white-space:nowrap}
td.wrap{white-space:normal;min-width:220px;max-width:380px}th{color:var(--mu);font-weight:500;font-size:11px;letter-spacing:.12em;text-transform:uppercase;background:var(--s2)}tr:last-child td{border-bottom:0}
.b{display:inline-block;padding:2px 9px;border-radius:99px;font-size:11px;border:1px solid var(--bd);color:var(--mu)}
.b-paid,.b-sent,.b-active,.b-approved{color:var(--ok);border-color:rgba(111,191,142,.35)}.b-failed,.b-cancelled,.b-expired,.b-rejected{color:var(--er);border-color:rgba(217,115,107,.35)}.b-pending,.b-processing{color:var(--ac);border-color:rgba(201,166,107,.35)}
.act{font:inherit;font-size:12px;padding:5px 11px;border-radius:7px;border:1px solid var(--bd);background:var(--s2);color:var(--tx);cursor:pointer;margin-right:4px}.act:hover{border-color:var(--ac)}.act.no{color:var(--er)}.act:disabled{opacity:.5;cursor:wait}
h2{font-size:15px;margin:26px 0 10px;font-weight:600}p.note{color:var(--mu);margin:0 0 10px;font-size:13px}.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px}
section[hidden]{display:none}
.topcard{background:var(--s);border:1px solid var(--bd);border-radius:12px;padding:14px 16px;margin-bottom:12px;display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start}
.topcard img{width:150px;max-height:220px;object-fit:contain;border-radius:8px;border:1px solid var(--bd);background:#000;cursor:zoom-in}
.topcard .meta{flex:1;min-width:180px}
.topcard .meta b{font-size:16px}
</style>
<header><h1>TAKAMURA ELITE · ADMIN</h1>
<nav role="tablist" aria-label="Sections">
<button role="tab" aria-selected="true" data-tab="overview">Overview</button><button role="tab" aria-selected="false" data-tab="users">Users</button>
<button role="tab" aria-selected="false" data-tab="topups">Recharges${pendingTopups ? ` (${pendingTopups})` : ''}</button><button role="tab" aria-selected="false" data-tab="reports">Reports</button></nav></header>

<section id="t-overview">
<div class="grid">
<div class="card"><small>Total users</small><strong>${totalUsers}</strong></div>
<div class="card"><small>Active wallets (≥ ${money(MIN_USABLE_BALANCE)})</small><strong>${activeWallets}</strong></div>
<div class="card"><small>Pending topups</small><strong>${pendingTopups}</strong></div>
<div class="card"><small>Reports</small><strong>${totalReports}</strong></div>
<div class="card"><small>Total credited</small><strong>${money(totalCredited)} <span style="font-size:13px;color:var(--mu)">${esc(WALLET_CURRENCY)}</span></strong></div>
</div>
<p class="note">Recharges are 100% manual: the user pays on the Money Fusion link, uploads a screenshot, and an admin reviews it here before the balance is credited. Money Fusion payment link: <span class="mono">${esc(MONEY_FUSION_URL)}</span></p>
</section>

<section id="t-users" hidden><div class="scroll"><table><tr><th>ID</th><th>Email</th><th>Verified</th><th>Balance</th><th>Created</th><th></th></tr>
${u.rows.map((x) => `<tr><td>${esc(x.id)}</td><td>${esc(x.email)}</td><td>${x.verified ? badge('active') : badge('pending')}</td><td>${esc(money(x.balance))} ${esc(WALLET_CURRENCY)}</td><td>${esc(fmtDate(x.created_at))}</td><td><button class="act" data-reset-user="${esc(x.id)}">Reset password</button><button class="act no" data-delete-user="${esc(x.id)}">Delete</button></td></tr>`).join('')}</table></div></section>

<section id="t-topups" hidden>
<h2>Pending review (${pending.rows.length})</h2>
${pending.rows.length ? pending.rows.map((x) => `<div class="topcard">
  <img src="${esc(x.proof_data)}" alt="Payment proof" loading="lazy" onclick="window.open(this.src,'_blank')">
  <div class="meta"><b>${esc(money(x.amount))} ${esc(x.currency)}</b><br>${esc(x.email)}<br><span class="mono" style="color:var(--mu)">${esc(fmtDate(x.created_at))}</span>
  <div style="margin-top:10px"><button class="act" data-topup-decide="${esc(x.id)}" data-action="approve">Approve &amp; credit</button><button class="act no" data-topup-decide="${esc(x.id)}" data-action="reject">Reject</button></div></div>
</div>`).join('') : '<p class="note">No pending recharge to review.</p>'}
<h2>History (${decided.rows.length})</h2>
<div class="scroll"><table><tr><th>Date</th><th>User</th><th>Amount</th><th>Status</th><th>Decided</th></tr>
${decided.rows.map((x) => `<tr><td>${esc(fmtDate(x.created_at))}</td><td>${esc(x.email)}</td><td>${esc(money(x.amount))} ${esc(x.currency)}</td><td>${badge(x.status)}</td><td>${esc(fmtDate(x.decided_at))}</td></tr>`).join('')}</table></div>
</section>

<section id="t-reports" hidden><div class="scroll"><table><tr><th>Date</th><th>User</th><th>Case</th><th>Category</th><th>Severity</th><th>Target</th><th>Message</th><th>Emails</th></tr>
${r.rows.map((x) => `<tr><td>${esc(fmtDate(x.created_at))}</td><td>${esc(x.email)}</td><td class="mono">${esc(x.case_id)}</td><td>${esc(x.category)}</td><td>${esc(x.severity)}</td><td>${esc(x.wa_number)}</td><td class="wrap">${esc(String(x.message || '').slice(0, 200))}</td><td>${esc(x.email_status)}</td></tr>`).join('')}</table></div></section>

<script nonce="${nonce}">
const tabs=[...document.querySelectorAll('[data-tab]')];
function show(n){tabs.forEach(t=>t.setAttribute('aria-selected',String(t.dataset.tab===n)));['overview','users','topups','reports'].forEach(k=>document.getElementById('t-'+k).hidden=k!==n);}
tabs.forEach(t=>t.addEventListener('click',()=>show(t.dataset.tab)));
async function post(url,body){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'takamura-admin'},body:JSON.stringify(body)});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Error');return d;}
document.addEventListener('click',async e=>{
  const b=e.target.closest('button.act');if(!b)return;
  if(b.dataset.action==='reject'&&b.dataset.topupDecide&&!confirm('Reject this recharge? Nothing will be credited.'))return;
  if(b.dataset.action==='approve'&&b.dataset.topupDecide&&!confirm('Credit this amount to the user\\'s balance? Only do this after checking the screenshot.'))return;
  if(b.dataset.deleteUser&&!confirm('Delete this user permanently? This cannot be undone. Their reports and recharge history are kept for records but will no longer show a linked account.'))return;
  if(b.dataset.resetUser&&!confirm('Generate a new temporary password for this user? Their current sessions will be signed out.'))return;
  b.disabled=true;
  try{
    if(b.dataset.topupDecide)await post('/admin/topups/decision',{id:b.dataset.topupDecide,action:b.dataset.action});
    else if(b.dataset.deleteUser){await post('/admin/users/delete',{id:b.dataset.deleteUser});location.reload();return;}
    else if(b.dataset.resetUser){const d=await post('/admin/users/reset-password',{id:b.dataset.resetUser});alert((d.emailed?'Emailed to the user.\\n\\n':'Could not email the user — share this manually.\\n\\n')+'Temporary password: '+d.tempPassword);b.disabled=false;return;}
    location.reload();
  }catch(err){alert(err.message);b.disabled=false;}
});
</script></html>`;
    res.type('html').send(html);
  } catch (e) {
    console.error('[admin]', e.message);
    res.status(500).send('Server error.');
  }
});

app.post('/admin/users/delete', limitAdmin, adminAuth, requireAdminXhr, async (req, res) => {
  try {
    const id = Number(req.body?.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid request.' });
    await db.execute({ sql: `DELETE FROM auth_tokens WHERE user_id = ?`, args: [id] });
    const r = await db.execute({ sql: `DELETE FROM users WHERE id = ?`, args: [id] });
    if (!rowsAffected(r)) return res.status(404).json({ error: 'User not found.' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[admin user delete]', e.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.post('/admin/users/reset-password', limitAdmin, adminAuth, requireAdminXhr, async (req, res) => {
  try {
    const id = Number(req.body?.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid request.' });
    const u = await db.execute({ sql: `SELECT email FROM users WHERE id = ?`, args: [id] });
    const user = u.rows && u.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const tempPassword = crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'Tk' + Date.now();
    await db.execute({ sql: `UPDATE users SET password_hash = ? WHERE id = ?`, args: [await hashPassword(tempPassword), id] });
    await db.execute({ sql: `DELETE FROM auth_tokens WHERE user_id = ?`, args: [id] }); // force sign-out everywhere

    let emailed = false;
    try {
      await mailer.sendMail({
        to: user.email,
        subject: 'Takamura Elite — Your password has been reset',
        text: `An administrator reset your password.\n\nTemporary password: ${tempPassword}\n\nPlease sign in and change your password as soon as possible.\n\n— Takamura Elite`,
        html: emailLayout({
          title: 'Mot de passe réinitialisé',
          intro: 'An administrator reset your password · Un administrateur a réinitialisé votre mot de passe.',
          bodyHtml: emailCode(tempPassword).replace('letter-spacing:.3em', 'letter-spacing:.08em').replace('30px', '22px') + emailNote('Connectez-vous puis changez ce mot de passe dès que possible. · Please sign in and change it as soon as possible.'),
        }),
        tags: ['password-reset'],
      });
      emailed = true;
    } catch (e) { console.error('[admin reset mail]', e.message); }

    res.json({ ok: true, tempPassword, emailed });
  } catch (e) {
    console.error('[admin user reset]', e.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// La seule route qui peut créditer un solde. 'approve' n'a d'effet que sur une ligne encore
// 'pending' (compare-and-set), donc un double-clic ou un rechargement de page ne peut jamais
// créditer deux fois la même recharge.
app.post('/admin/topups/decision', limitAdmin, adminAuth, requireAdminXhr, async (req, res) => {
  try {
    const id = String(req.body?.id || '');
    const action = String(req.body?.action || '');
    if (!UUID_RE.test(id) || !['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid request.' });
    const t = await getTopup(id);
    if (!t) return res.status(404).json({ error: 'Recharge not found.' });
    if (t.status !== 'pending') return res.status(409).json({ error: 'Already processed.' });

    const now = Date.now();
    if (action === 'reject') {
      await db.execute({ sql: `UPDATE topups SET status = 'rejected', decided_at = ? WHERE id = ? AND status = 'pending'`, args: [now, id] });
      const u = await db.execute({ sql: `SELECT email FROM users WHERE id = ?`, args: [t.user_id] });
      if (u.rows[0]) sendTopupDecisionEmail(u.rows[0].email, t, 'rejected', null).catch(() => {});
      return res.json({ ok: true });
    }
    const r = await db.execute({ sql: `UPDATE topups SET status = 'approved', decided_at = ? WHERE id = ? AND status = 'pending'`, args: [now, id] });
    if (!rowsAffected(r)) return res.status(409).json({ error: 'Already processed.' });
    await db.execute({ sql: `UPDATE users SET balance = balance + ? WHERE id = ?`, args: [Number(t.amount), t.user_id] });
    const u = await db.execute({ sql: `SELECT email, balance FROM users WHERE id = ?`, args: [t.user_id] });
    if (u.rows[0]) sendTopupDecisionEmail(u.rows[0].email, t, 'approved', Number(u.rows[0].balance)).catch(() => {});
    res.json({ ok: true, newBalance: u.rows[0] ? Number(u.rows[0].balance) : null });
  } catch (e) {
    console.error('[admin decision]', e.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

/* ================================== ERRORS ================================= */
/* ======================= VÉRIFICATION DE NUMÉRO (Baron0) ======================= */
// Champs connus de l'API ; tout autre champ simple renvoyé par l'API est transmis tel quel dans `extra`,
// pour que l'interface affiche tout ce que ton plan Baron0 fournit (sans qu'il faille modifier le code).
const CHECK_KNOWN_KEYS = new Set(['banned', 'ban_type', 'banType', 'mod_block', 'modBlock', 'violation', 'category',
  'appeal', 'eu', 'banned_at', 'bannedAt', 'appeal_filed', 'appealFiled', 'number', 'phone']);
const checkScalar = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v).slice(0, 300) : typeof v === 'string' ? v.slice(0, 300) : v);

function normalizeCheck(number, data) {
  const d = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const pick = (...keys) => { for (const k of keys) if (d[k] !== undefined && d[k] !== null && d[k] !== '') return checkScalar(d[k]); return null; };
  const banType = pick('ban_type', 'banType');
  const modBlock = d.mod_block === true || d.modBlock === true || (typeof banType === 'string' && /mod/i.test(banType));
  const banned = d.banned === true;
  const status = banned ? 'banned' : modBlock ? 'restricted' : d.banned === false ? 'normal' : 'unknown';
  const extra = {};
  for (const [k, v] of Object.entries(d)) {
    if (Object.keys(extra).length >= 20) break;
    if (CHECK_KNOWN_KEYS.has(k) || v === undefined || v === null || v === '' || !/^[A-Za-z0-9_.-]{1,40}$/.test(k)) continue;
    extra[k] = checkScalar(v);
  }
  return {
    number, status, banned, modBlock, banType,
    violation: pick('violation'), category: pick('category'), appeal: pick('appeal'), eu: pick('eu'),
    bannedAt: pick('banned_at', 'bannedAt'), appealFiled: pick('appeal_filed', 'appealFiled'), extra,
  };
}

// Appel unique à l'API Baron0 (utilisé par la page « Vérifier », l'envoi des signalements et la surveillance).
async function callBanCheck(number, timeoutMs = CHECK_TIMEOUT_MS) {
  let apiRes, data = null;
  try {
    apiRes = await fetch(`${BANCHECK_API_BASE}/api/v2/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + BANCHECK_API_KEY },
      body: JSON.stringify({ number }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    data = await apiRes.json().catch(() => null);
  } catch (e) {
    const err = new Error('network: ' + e.message); err.code = 'network'; throw err;
  }
  if (!apiRes.ok) { // erreurs problem+json : { type, title, status, detail, instance, requestId }
    const err = new Error(`API ${apiRes.status} ${(data && (data.title || data.detail)) || ''} ${(data && data.requestId) || ''}`.trim());
    err.code = 'api'; err.apiStatus = apiRes.status; err.detail = data && data.detail; throw err;
  }
  return normalizeCheck(number, data);
}

app.post('/api/checkban', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Not authenticated.' });
    const balance = await getBalance(user.id);
    if (balance < MIN_USABLE_BALANCE) return res.status(403).json({ error: `Solde insuffisant. Rechargez au moins ${money(MIN_USABLE_BALANCE)} ${WALLET_CURRENCY} pour utiliser la plateforme.` });

    const digits = String(req.body?.phone || '').replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) return res.status(400).json({ error: 'Numéro invalide (format international, ex. +237 6XX XXX XXX).' });
    const number = '+' + digits;

    let result;
    try { result = await callBanCheck(number); }
    catch (e) {
      console.error('[checkban]', e.message);
      if (e.code === 'api' && (e.apiStatus === 400 || e.apiStatus === 422)) return res.status(400).json({ error: e.detail || 'Numéro refusé par le service.' });
      if (e.code === 'api' && e.apiStatus === 429) return res.status(503).json({ error: 'Service surchargé, réessayez dans un instant.' });
      return res.status(502).json({ error: e.code === 'network' ? 'Impossible de contacter le service de vérification.' : 'Le service de vérification est indisponible pour le moment.' });
    }
    const ins = await db.execute({
      sql: `INSERT INTO checks (user_id, number, status, result, created_at) VALUES (?, ?, ?, ?, ?)`,
      args: [user.id, number, result.status, JSON.stringify(result), Date.now()],
    });
    res.json({ ok: true, id: Number(ins.lastInsertRowid || 0), createdAt: Date.now(), result });
  } catch (e) {
    console.error('[checkban]', e.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

/* ================= SURVEILLANCE DES NUMÉROS CIBLÉS (après envoi + toutes les 15 min) ================= */
// Extrait les chiffres d'une cible : numéro brut, lien wa.me/… ou api.whatsapp.com/send?phone=… (liens de groupe : non vérifiables).
function targetDigits(t) {
  const s = String(t || '').trim();
  const m = s.match(/(?:wa\.me\/|[?&]phone=)\+?(\d{8,15})/i);
  if (m) return m[1];
  if (/^\+?[0-9 ()\-]{6,20}$/.test(s)) { const d = s.replace(/\D/g, ''); return d.length >= 8 && d.length <= 15 ? d : null; }
  return null;
}

// Vérifie un numéro suivi et enregistre le résultat ; `changed` = le statut a changé depuis la vérification précédente.
async function checkWatched(digits, timeoutMs = CHECK_TIMEOUT_MS) {
  const result = await callBanCheck('+' + digits, timeoutMs);
  const now = Date.now();
  const prev = await db.execute({ sql: `SELECT status FROM watched_numbers WHERE number = ?`, args: [digits] });
  const prevStatus = prev.rows[0] ? prev.rows[0].status : null;
  const changed = !!prevStatus && prevStatus !== result.status;
  await db.execute({
    sql: `UPDATE watched_numbers SET status = ?, result = ?, checked_at = ?, changed_at = CASE WHEN ? = 1 THEN ? ELSE changed_at END, check_count = check_count + 1, error_count = 0 WHERE number = ?`,
    args: [result.status, JSON.stringify(result), now, changed ? 1 : 0, now, digits],
  });
  return { result, checkedAt: now, changed };
}

// Appelé après chaque envoi : enregistre le numéro dans la surveillance puis le vérifie tout de suite.
async function watchTarget(digits) {
  const now = Date.now();
  await db.execute({
    sql: `INSERT INTO watched_numbers (number, first_seen, last_report_at) VALUES (?, ?, ?) ON CONFLICT(number) DO UPDATE SET last_report_at = excluded.last_report_at`,
    args: [digits, now, now],
  });
  const cur = await db.execute({ sql: `SELECT status, result, checked_at FROM watched_numbers WHERE number = ?`, args: [digits] });
  const row = cur.rows[0];
  if (row && row.status && row.checked_at && now - Number(row.checked_at) < WATCH_REUSE_MS) {
    try { return { result: JSON.parse(row.result), checkedAt: Number(row.checked_at), changed: false }; } catch (_) { /* résultat illisible : on revérifie */ }
  }
  return checkWatched(digits, 8000);
}

let watchRunning = false;
async function runWatchCycle() {
  if (watchRunning) return;
  watchRunning = true;
  try {
    const due = await db.execute({
      sql: `SELECT number FROM watched_numbers WHERE last_report_at > ? AND (status IS NULL OR status != 'banned') ORDER BY COALESCE(checked_at, 0) ASC`,
      args: [Date.now() - WATCH_MAX_AGE_MS],
    });
    let done = 0, changed = 0;
    for (const row of due.rows) {
      try { const x = await checkWatched(row.number); done++; if (x.changed) changed++; }
      catch (e) {
        console.error('[watch]', row.number, e.message);
        await db.execute({ sql: `UPDATE watched_numbers SET error_count = error_count + 1 WHERE number = ?`, args: [row.number] }).catch(() => {});
        if (e.code === 'api' && [401, 403, 429].includes(e.apiStatus)) break; // clé refusée ou quota atteint : inutile d'insister ce cycle
      }
      await new Promise((resolve) => setTimeout(resolve, WATCH_DELAY_MS));
    }
    if (due.rows.length) console.log(`[watch] ${done}/${due.rows.length} checked, ${changed} status change(s)`);
  } catch (e) {
    console.error('[watch cycle]', e.message);
  } finally {
    watchRunning = false;
  }
}

app.get('/api/checks', limitPayStatus, async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Not authenticated.' });
    const r = await db.execute({ sql: `SELECT id, number, status, result, created_at FROM checks WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`, args: [user.id] });
    const checks = r.rows.map((x) => {
      let result = null; try { result = JSON.parse(x.result); } catch (_) { /* ligne illisible : ignorée */ }
      return { id: Number(x.id), number: x.number, status: x.status, createdAt: Number(x.created_at), result };
    });
    res.json({ checks });
  } catch (e) {
    console.error('[checks]', e.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown route.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
  console.error('[ERR]', err && err.message);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

/* ================================== BOOT =================================== */
(async () => {
  await initDb();
  app.listen(PORT, () => console.log(`[HTTP] Takamura Elite listening on ${PORT} (wallet mode — Money Fusion manual review)`));
  setInterval(() => { runWatchCycle(); }, WATCH_INTERVAL_MS);
  console.log(`[watch] target numbers re-checked every ${WATCH_INTERVAL_MS / 60000} min`);
})().catch((e) => {
  console.error('[BOOT] Startup failed:', e && e.message);
  process.exit(1);
});
