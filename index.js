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
const ADMIN_EMAIL = 'yenohyenoh209@gmail.com';
const ADMIN_PASSWORD = 'TAKAMURA-ADMIN-2026';

// Recharge de portefeuille via Money Fusion — lien de paiement unique, fourni par l'admin.
// Le client paie sur ce lien (tous moyens acceptés par Money Fusion), puis envoie la capture
// d'écran du paiement. Un admin vérifie la preuve et approuve manuellement le crédit du solde.
const MONEY_FUSION_URL = 'https://my.moneyfusion.net/69baa0c5d64e43f8715d8bf8';
const WALLET_CURRENCY = env('WALLET_CURRENCY', 'FCFA');
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
  'support@support.whatsapp.com': 'General support',
  'support@whatsapp.com': 'Support',
  'android@support.whatsapp.com': 'Android',
  'smb@support.whatsapp.com': 'WhatsApp Business',
  'accessibility@support.whatsapp.com': 'Accessibility',
};

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
async function sendViaBrevo({ to, subject, text, html }) {
  if (!BREVO_API_KEY || !BREVO_SENDER_EMAIL) throw new Error('Email provider not configured');
  const payload = { sender: { name: 'Takamura Elite', email: BREVO_SENDER_EMAIL }, to: [{ email: to }], subject, textContent: text };
  if (html) payload.htmlContent = html;
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Brevo responded ${res.status}`);
  return res.json();
}
const mailer = { sendMail: sendViaBrevo };

async function sendVerificationEmail(email, code) {
  const minutes = Math.round(CODE_TTL_MS / 60000);
  const subject = `Takamura Elite — ${code} is your verification code`;
  const text =
    `Your Takamura Elite verification code / Votre code de vérification :\n\n    ${code}\n\n` +
    `Valid for ${minutes} minutes / Valable ${minutes} minutes.\n` +
    `If you did not create this account, ignore this email.\n\n— Takamura Elite`;
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#0a0a0b;color:#ece8df;padding:32px;border-radius:12px;max-width:480px">
      <div style="font-size:12px;letter-spacing:.24em;color:#c9a66b;margin-bottom:18px">TAKAMURA ELITE</div>
      <p style="margin:0 0 20px;color:#b9b6ae">Your verification code · Votre code de vérification</p>
      <div style="display:inline-block;font-size:32px;letter-spacing:.32em;font-weight:600;color:#e0c48a;background:#141416;padding:14px 22px;border:1px solid rgba(201,166,107,.35);border-radius:10px">${esc(code)}</div>
      <p style="margin:22px 0 0;color:#8b8a86;font-size:12px">Valid for ${minutes} minutes. If you did not create this account, ignore this email.</p>
    </div>`;
  return mailer.sendMail({ to: email, subject, text, html });
}
async function sendWhatsAppReport({ caseId, category, severity, waNumber, message, destination }) {
  const subject = `Signalement WhatsApp — ${category} — ${waNumber}`;
  let body = `${caseId}\n`;
  body += `Catégorie : ${category}\nGravité : ${severity}\nNuméro / lien WhatsApp signalé : ${waNumber}\n\n`;
  if (message) body += `Message litigieux (copié par le déclarant) :\n${message}\n\n`;
  body += `Merci d'examiner ce compte pour violation des conditions d'utilisation WhatsApp.\n`;
  return mailer.sendMail({ to: destination, subject, text: body });
}
async function sendTopupDecisionEmail(email, topup, decision, newBalance) {
  try {
    const subject = decision === 'approved'
      ? `Takamura Elite — Recharge de ${money(topup.amount)} ${WALLET_CURRENCY} approuvée`
      : `Takamura Elite — Recharge de ${money(topup.amount)} ${WALLET_CURRENCY} refusée`;
    const text = decision === 'approved'
      ? `Votre recharge a été vérifiée et approuvée par un administrateur.\n\nMontant crédité : ${money(topup.amount)} ${WALLET_CURRENCY}\nNouveau solde : ${money(newBalance)} ${WALLET_CURRENCY}\n\n— Takamura Elite`
      : `Votre demande de recharge de ${money(topup.amount)} ${WALLET_CURRENCY} n'a pas pu être validée (preuve de paiement introuvable ou incorrecte). Vous pouvez soumettre une nouvelle demande avec une capture d'écran valide.\n\n— Takamura Elite`;
    await mailer.sendMail({ to: email, subject, text });
  } catch (e) { console.error('[MAIL topup]', e.message); }
}
async function sendAdminTopupNotice(email, amount) {
  if (!ADMIN_EMAIL) return;
  try {
    await mailer.sendMail({
      to: ADMIN_EMAIL,
      subject: `[Takamura] Nouvelle demande de recharge — ${money(amount)} ${WALLET_CURRENCY}`,
      text: `Compte : ${email}\nMontant déclaré : ${money(amount)} ${WALLET_CURRENCY}\n\nÀ vérifier et approuver dans /admin (onglet Recharges).`,
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
    const message = cleanText(req.body?.message, 5000);
    if (!category || !waNumber) return res.status(400).json({ error: 'Category and target are required.' });
    if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category.' });
    if (!SEVERITIES.includes(severity)) return res.status(400).json({ error: 'Invalid severity.' });
    if (!WA_TARGET_RE.test(waNumber)) return res.status(400).json({ error: 'Invalid WhatsApp number or link.' });

    const sentToday = await countRows(`SELECT COUNT(*) AS c FROM reports WHERE user_id = ? AND created_at > ?`, [user.id, Date.now() - 24 * 60 * 60 * 1000]);
    if (sentToday >= MAX_REPORTS_PER_DAY) return res.status(429).json({ error: 'Daily report limit reached.' });

    const requested = Array.isArray(req.body?.destinations) ? req.body.destinations : [];
    const dests = requested.length ? [...new Set(requested.filter((d) => WHATSAPP_EMAILS.includes(d)))] : WHATSAPP_EMAILS;
    if (!dests.length) return res.status(400).json({ error: 'No valid destination selected.' });

    const caseId = newCaseId();
    const results = await Promise.allSettled(dests.map((d) => sendWhatsAppReport({ caseId, category, severity, waNumber, message, destination: d })));
    results.forEach((r, i) => { if (r.status === 'rejected') console.error('[report mail]', dests[i], r.reason && r.reason.message); });
    const ok = results.filter((r) => r.status === 'fulfilled').length;

    await db.execute({
      sql: `INSERT INTO reports (user_id, case_id, category, severity, wa_number, message, created_at, email_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [user.id, caseId, category, severity, waNumber, message, Date.now(), `${ok}/${dests.length}`],
    });
    res.json({ sent: ok, total: dests.length, caseId });
  } catch (e) {
    console.error('[report]', e.message);
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
    res.json({
      reports: r.rows.map((x) => {
        const [ok, total] = String(x.email_status || '0/0').split('/').map(Number);
        return {
          caseId: x.case_id, createdAt: Number(x.created_at), category: x.category, severity: x.severity,
          target: x.wa_number, status: ok > 0 ? 'sent' : 'failed', delivered: ok || 0, total: total || 0,
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
})().catch((e) => {
  console.error('[BOOT] Startup failed:', e && e.message);
  process.exit(1);
});
