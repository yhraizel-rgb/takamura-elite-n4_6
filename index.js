'use strict';

/* ============================================================================
   TAKAMURA ELITE — index.js (v3)
   Accounts + email verification (6-digit code) + AUTOMATED payment via Money Fusion
   (moneyfusion.net) + reports + history + admin.

   Files: index.html, index.js, package.json only.
   Valeurs en dur à la demande — seule BREVO_API_KEY reste en variable d'environnement
   (voir le bloc ENV ci-dessous et la note de sécurité en fin de réponse).
   ============================================================================ */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
// Bibliothèque officielle-écosystème pour l'API de paiement Money Fusion (create + statut).
// Utilisée pour ne PAS deviner le format JSON exact de leur API non documentée publiquement.
const { FusionPay } = require('fusionpay');

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
const ADMIN_PASSWORD = 'TAKAMURA';

// Money Fusion (https://moneyfusion.net) — remplace NotchPay/CamPay.
// L'URL ci-dessous N'EST PAS un des deux liens "Lien de paiement" du dashboard (ceux-là sont des
// pages figées pour vendre un produit à prix fixe et ne permettent pas d'associer un user_id).
// Il faut créer une APPLICATION de paiement (API) dans le dashboard Money Fusion — pas un lien —
// pour obtenir une URL d'API propre au compte. Remplace la valeur ci-dessous par cette URL.
const MONEYFUSION_API_URL = 'https://www.pay.moneyfusion.net/DevHub/b9d10a3669a238e9/pay/';
const PUBLIC_BASE_URL = 'https://takamura-elite2026.up.railway.app';
const CURRENCY_LABEL = 'FCFA';
const PAYMENTS_ENABLED = !!(MONEYFUSION_API_URL && !MONEYFUSION_API_URL.startsWith('REPLACE_'));

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
if (!PAYMENTS_ENABLED) console.warn('[BOOT] MONEYFUSION_API_URL not set (still the placeholder value): payments disabled.');

const { createClient } = require('@tursodatabase/serverless/compat');
const db = createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });

/* ============================== CONSTANTS ================================== */
const CODE_TTL_MS = 15 * 60 * 1000;
const CODE_COOLDOWN_MS = 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_REPORTS_PER_DAY = 20;
const PAYMENT_TTL_MS = 15 * 60 * 1000; // an unpaid payment attempt expires after 15 minutes
const RECONCILE_MIN_GAP_MS = 8000;

const PLANS = {
  day: { key: 'day', label: '24 hours', price: 1000, durationMs: 24 * 60 * 60 * 1000, currency: CURRENCY_LABEL },
  week: { key: 'week', label: '1 week', price: 2500, durationMs: 7 * 24 * 60 * 60 * 1000, currency: CURRENCY_LABEL },
};

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
    created_at INTEGER NOT NULL
  )`);
  await ensureColumn('users', 'verified', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('users', 'verification_code', 'TEXT');
  await ensureColumn('users', 'verification_expires', 'INTEGER');
  await ensureColumn('users', 'verification_attempts', 'INTEGER NOT NULL DEFAULT 0');
  // is_free = compte à accès illimité et gratuit (aucun paiement requis, aucune limite de quota).
  // Sert notamment à donner à l'admin un accès "utilisateur" complet en plus du tableau /admin.
  await ensureColumn('users', 'is_free', 'INTEGER NOT NULL DEFAULT 0');

  await db.execute(`CREATE TABLE IF NOT EXISTS auth_tokens (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER,
    plan TEXT NOT NULL,
    price INTEGER NOT NULL,
    payer_name TEXT,
    payer_phone TEXT,
    transaction_ref TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
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
  // Automated payments: one row per attempt. Access is only ever created from a row that the
  // server itself moved to 'paid' after the provider confirmed the transaction.
  await db.execute(`CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    plan TEXT NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL,
    method TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_ref TEXT,
    phone_hint TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    operator TEXT,
    operator_ref TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    paid_at INTEGER,
    expires_at INTEGER,
    last_check INTEGER NOT NULL DEFAULT 0
  )`);

  await ensureColumn('auth_tokens', 'user_id', 'INTEGER');
  await ensureColumn('auth_tokens', 'created_at', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('sessions', 'user_id', 'INTEGER');
  await ensureColumn('sessions', 'plan', 'TEXT');
  await ensureColumn('sessions', 'price', 'INTEGER');
  await ensureColumn('sessions', 'payer_name', 'TEXT');
  await ensureColumn('sessions', 'payer_phone', 'TEXT');
  await ensureColumn('sessions', 'transaction_ref', 'TEXT');
  await ensureColumn('sessions', 'status', "TEXT NOT NULL DEFAULT 'active'");
  await ensureColumn('sessions', 'created_at', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('sessions', 'expires_at', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('reports', 'user_id', 'INTEGER');
  await ensureColumn('reports', 'case_id', 'TEXT');
  await ensureColumn('reports', 'category', 'TEXT');
  await ensureColumn('reports', 'severity', 'TEXT');
  await ensureColumn('reports', 'wa_number', 'TEXT');
  await ensureColumn('reports', 'message', 'TEXT');
  await ensureColumn('reports', 'created_at', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('reports', 'email_status', 'TEXT');

  for (const sql of [
    `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_reports_user ON reports(user_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status, created_at)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_ref ON payments(provider_ref)`,
  ]) {
    try { await db.execute(sql); } catch (e) { console.warn('[DB] Index skipped:', e.message); }
  }
  await db.execute({ sql: `DELETE FROM auth_tokens WHERE created_at < ?`, args: [Date.now() - TOKEN_TTL_MS] });
  console.log('[DB] Tables ready.');
}

// Crée (ou met à niveau) un compte utilisateur "normal" pour l'admin, avec accès gratuit illimité,
// afin qu'il puisse aussi se connecter côté app (pas seulement sur /admin) et tout utiliser sans payer.
async function ensureAdminUserAccount() {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return;
  const email = ADMIN_EMAIL.trim().toLowerCase();
  const r = await db.execute({ sql: `SELECT id FROM users WHERE email = ?`, args: [email] });
  const passwordHash = await hashPassword(ADMIN_PASSWORD);
  if (r.rows[0]) {
    await db.execute({
      sql: `UPDATE users SET password_hash = ?, verified = 1, is_free = 1 WHERE id = ?`,
      args: [passwordHash, r.rows[0].id],
    });
  } else {
    await db.execute({
      sql: `INSERT INTO users (email, password_hash, verified, is_free, created_at) VALUES (?, ?, 1, 1, ?)`,
      args: [email, passwordHash, Date.now()],
    });
  }
  console.log(`[DB] Admin app-account ready (${email}), free access enabled.`);
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
const limitWebhook = rateLimit({ windowMs: 15 * MIN, max: 300 });
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
    sql: `SELECT u.id, u.email, u.verified, u.created_at, u.is_free
          FROM auth_tokens t JOIN users u ON u.id = t.user_id
          WHERE t.token = ? AND t.created_at > ?`,
    args: [sha256(token), Date.now() - TOKEN_TTL_MS],
  });
  return (r.rows && r.rows[0]) || null;
}
// Accès "illimité" pour les comptes is_free = 1 : pas de ligne sessions, pas de paiement,
// pas de limite quotidienne de signalements. Renvoie la même forme que getActiveSession().
const FREE_PLAN_EXPIRES = Date.now() + 100 * 365 * 24 * 60 * 60 * 1000; // ~100 ans = "illimité"
async function getAccessForUser(user) {
  if (user && Number(user.is_free)) return { token: 'free', plan: 'free', expires_at: FREE_PLAN_EXPIRES };
  return getActiveSession(user.id);
}
async function issueToken(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  await db.execute({
    sql: `INSERT INTO auth_tokens (token, user_id, created_at) VALUES (?, ?, ?)`,
    args: [sha256(token), userId, Date.now()],
  });
  return token;
}
async function getActiveSession(userId) {
  const r = await db.execute({
    sql: `SELECT token, plan, expires_at FROM sessions
          WHERE user_id = ? AND status = 'active' AND expires_at > ?
          ORDER BY expires_at DESC LIMIT 1`,
    args: [userId, Date.now()],
  });
  return (r.rows && r.rows[0]) || null;
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
async function sendAccessActivatedEmail(email, planLabel, expiresAt) {
  try {
    await mailer.sendMail({
      to: email,
      subject: 'Takamura Elite — Your access is active',
      text: `Your payment was confirmed.\n\nPlan: ${planLabel}\nExpires: ${new Date(expiresAt).toLocaleString('en-GB', { timeZone: 'Africa/Douala' })} (Douala)\n\n— Takamura Elite`,
    });
  } catch (e) { console.error('[MAIL activation]', e.message); }
}
async function sendAdminPaymentNotice(email, plan, amount, method) {
  if (!ADMIN_EMAIL) return;
  try {
    await mailer.sendMail({
      to: ADMIN_EMAIL,
      subject: `[Takamura] Payment confirmed — ${plan.label} (${amount} ${plan.currency})`,
      text: `Payment confirmed by provider.\n\nAccount: ${email}\nPlan: ${plan.label}\nAmount: ${amount} ${plan.currency}\nMethod: ${method}\n`,
    });
  } catch (e) { console.error('[MAIL admin]', e.message); }
}

/* ============================ PAYMENT PROVIDER ============================= */
// Money Fusion flow (server side only — the browser never talks to the provider's API directly,
// it is only ever redirected to the hosted checkout page returned by makePayment()):
//   fp.makePayment()        -> { statut, token, message, url }         (url = hosted checkout page)
//   fp.checkPaymentStatus() -> { statut, data: { tokenPay, Montant, frais, statut: paid|pending|failed|no paid,
//                                                personal_Info: [...], moyen, numeroTransaction, ... } }
//   Webhook: Money Fusion POSTs the same "data" shape to webhook_url. Money Fusion does not publicly
//            document a webhook signature scheme, so — exactly like the payment engine this replaces —
//            the webhook body is ONLY used to know which payment to re-check. The real confirmation always
//            comes from calling checkPaymentStatus() ourselves with our own API URL (see reconcile()/applyProviderTx()).
//   personal_Info is how we associate the transaction with our own user_id/payment_id (see /api/payment/start).
const provider = {
  async collect({ amount, phone, planLabel, personalInfo }) {
    const fp = new FusionPay(MONEYFUSION_API_URL);
    fp.totalPrice(amount)
      .addArticle(planLabel, amount)
      .clientName('Takamura Elite')
      .clientNumber(phone)
      .addInfo(personalInfo)
      .returnUrl(`${PUBLIC_BASE_URL}/`)
      .webhookUrl(`${PUBLIC_BASE_URL}/api/payment/moneyfusion/webhook`);
    const r = await fp.makePayment();
    if (!r || r.statut !== true || !r.token || !r.url) throw new Error(`Money Fusion: unexpected response (${r && r.message})`);
    return { token: String(r.token), url: String(r.url) };
  },
  async getTransaction(token) {
    const fp = new FusionPay(MONEYFUSION_API_URL);
    const r = await fp.checkPaymentStatus(token);
    if (!r || r.statut !== true || !r.data) return {};
    const d = r.data;
    return {
      status: String(d.statut || '').toLowerCase(), // 'paid' | 'pending' | 'failed' | 'no paid'
      token: d.tokenPay,
      amount: Number(d.Montant),
      fees: Number(d.frais || 0),
      moyen: d.moyen,
      numeroTransaction: d.numeroTransaction,
      personalInfo: Array.isArray(d.personal_Info) ? d.personal_Info[0] : (d.personal_Info || null),
    };
  },
};

/* ============================ PAYMENT DOMAIN LOGIC ========================= */
const getPayment = async (id) => {
  const r = await db.execute({ sql: `SELECT * FROM payments WHERE id = ?`, args: [id] });
  return (r.rows && r.rows[0]) || null;
};
function publicPayment(p) {
  return {
    id: p.id, status: p.status, plan: p.plan, amount: Number(p.amount),
    method: p.method, createdAt: Number(p.created_at),
    expiresAt: p.status === 'paid' ? Number(p.expires_at) : null,
  };
}

// Creates the access row for a payment the SERVER has marked paid. INSERT OR IGNORE on a
// deterministic token makes it idempotent: the same payment can never create two sessions.
async function ensureSession(paymentId) {
  const p = await getPayment(paymentId);
  if (!p || p.status !== 'paid' || !p.expires_at) return;
  await db.execute({
    sql: `INSERT OR IGNORE INTO sessions
          (token, user_id, plan, price, payer_name, payer_phone, transaction_ref, status, created_at, expires_at)
          VALUES (?, ?, ?, ?, '', ?, ?, 'active', ?, ?)`,
    args: [`pay_${p.id}`, p.user_id, p.plan, p.amount, p.phone_hint || '', p.provider_ref || '', p.paid_at, p.expires_at],
  });
}
async function repairPaidSessions(userId) {
  const r = await db.execute({
    sql: `SELECT p.id FROM payments p
          WHERE p.user_id = ? AND p.status = 'paid' AND p.expires_at > ?
            AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.token = 'pay_' || p.id)`,
    args: [userId, Date.now()],
  });
  for (const row of r.rows || []) await ensureSession(row.id);
}

async function activatePayment(p, tx) {
  const plan = PLANS[p.plan];
  if (!plan) return p;
  const now = Date.now();
  const active = await getActiveSession(p.user_id);
  const base = Math.max(now, active ? Number(active.expires_at) : 0); // renewing while active stacks time
  const expiresAt = base + plan.durationMs;
  // Compare-and-set: only the first confirmation flips the row; every replay affects 0 rows.
  const r = await db.execute({
    sql: `UPDATE payments SET status = 'paid', paid_at = ?, expires_at = ?, operator = ?, operator_ref = ?, updated_at = ?
          WHERE id = ? AND status != 'paid'`,
    args: [now, expiresAt, cleanLine(tx.operator, 20), cleanLine(tx.operator_reference, 60), now, p.id],
  });
  const first = rowsAffected(r) === 1;
  await ensureSession(p.id);
  if (first) {
    const u = await db.execute({ sql: `SELECT email FROM users WHERE id = ?`, args: [p.user_id] });
    const email = u.rows[0] && u.rows[0].email;
    if (email) {
      sendAccessActivatedEmail(email, plan.label, expiresAt).catch(() => {});
      sendAdminPaymentNotice(email, plan, p.amount, p.method).catch(() => {});
    }
  }
  return getPayment(p.id);
}

// The only place a provider answer changes a payment. Every field is checked against OUR record.
async function applyProviderTx(p, tx) {
  if (!tx || typeof tx !== 'object') return p;
  const st = String(tx.status || '');
  if (p.status === 'paid') return p;

  if (st === 'paid') {
    const okToken = String(tx.token || '') === String(p.provider_ref || '');
    const pi = tx.personalInfo || {};
    const okPaymentId = !pi.paymentId || String(pi.paymentId) === String(p.id);
    // Money Fusion's "Montant" can be net of its own fees ("frais"), so accept either the raw
    // amount or amount+fees matching what we asked for — but never anything less than our price.
    const received = Number(tx.amount || 0);
    const gross = received + Number(tx.fees || 0);
    const okAmount = received === Number(p.amount) || gross === Number(p.amount);
    if (!(okToken && okPaymentId && okAmount)) {
      console.error(`[payment] MISMATCH on ${p.id}: token=${okToken} paymentId=${okPaymentId} amount=${okAmount} (Montant=${tx.amount} frais=${tx.fees} expected=${p.amount})`);
      await db.execute({ sql: `UPDATE payments SET status = 'failed', updated_at = ? WHERE id = ? AND status != 'paid'`, args: [Date.now(), p.id] });
      return getPayment(p.id);
    }
    return activatePayment(p, { operator: tx.moyen, operator_reference: tx.numeroTransaction });
  }
  if (st === 'failed' || st === 'no paid') {
    await db.execute({
      sql: `UPDATE payments SET status = 'failed', updated_at = ? WHERE id = ? AND status IN ('pending','processing','cancelled')`,
      args: [Date.now(), p.id],
    });
    return getPayment(p.id);
  }
  if (['pending', 'processing'].includes(p.status) && Date.now() - Number(p.created_at) > PAYMENT_TTL_MS) {
    await db.execute({ sql: `UPDATE payments SET status = 'expired', updated_at = ? WHERE id = ? AND status IN ('pending','processing')`, args: [Date.now(), p.id] });
    return getPayment(p.id);
  }
  return p;
}

async function reconcile(p, { force = false } = {}) {
  if (!PAYMENTS_ENABLED || !p.provider_ref || p.status === 'paid') return p;
  if (!force && Date.now() - Number(p.last_check) < RECONCILE_MIN_GAP_MS) return p;
  await db.execute({ sql: `UPDATE payments SET last_check = ? WHERE id = ?`, args: [Date.now(), p.id] });
  let tx;
  try { tx = await provider.getTransaction(p.provider_ref); } catch (e) { console.error('[payment reconcile]', e.message); return p; }
  return applyProviderTx(p, tx);
}

async function sweepPayments() {
  try {
    await db.execute({
      sql: `UPDATE payments SET status = 'expired', updated_at = ? WHERE status IN ('pending','processing') AND created_at < ?`,
      args: [Date.now(), Date.now() - PAYMENT_TTL_MS],
    });
  } catch (e) { console.error('[sweep]', e.message); }
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
app.use(express.json({ limit: '100kb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
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
    plans: Object.values(PLANS).map((p) => ({ key: p.key, label: p.label, price: p.price, currency: p.currency })),
    paymentsEnabled: PAYMENTS_ENABLED,
    paymentTtlMinutes: Math.round(PAYMENT_TTL_MS / 60000),
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
    await repairPaidSessions(user.id);
    const sess = await getAccessForUser(user);
    const reports = await countRows(`SELECT COUNT(*) AS c FROM reports WHERE user_id = ?`, [user.id]);
    let pendingPayment = null;
    if (!sess) {
      const r = await db.execute({
        sql: `SELECT * FROM payments WHERE user_id = ? AND status IN ('pending','processing') AND created_at > ?
              ORDER BY created_at DESC LIMIT 1`,
        args: [user.id, Date.now() - PAYMENT_TTL_MS],
      });
      if (r.rows[0]) pendingPayment = publicPayment(r.rows[0]);
    }
    res.json({
      user: { id: user.id, email: user.email, createdAt: Number(user.created_at), isFree: !!Number(user.is_free) },
      hasAccess: !!sess,
      pending: !!pendingPayment,
      pendingPayment,
      reports,
      access: sess ? { plan: sess.plan, expiresAt: Number(sess.expires_at) } : null,
    });
  } catch (e) {
    console.error('[me]', e.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

/* ---------------------------------- PAYMENT --------------------------------- */
// Creates a REAL transaction at the provider. The client only chooses plan + phone;
// price, currency and duration are decided here. Nothing the client sends can grant access.
// personal_Info = { paymentId, userId } is how the eventual confirmation is tied back to this
// exact user account (see applyProviderTx) — the user never types their own user_id anywhere.
app.post('/api/payment/start', limitPayStart, async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Please sign in first.' });
    if (!user.verified) return res.status(403).json({ error: 'Account not verified.' });
    if (Number(user.is_free)) return res.status(400).json({ error: 'This account already has free unlimited access.' });
    if (!PAYMENTS_ENABLED) return res.status(503).json({ error: 'Payments are temporarily unavailable.' });

    const plan = Object.prototype.hasOwnProperty.call(PLANS, req.body?.plan) ? PLANS[req.body.plan] : null;
    if (!plan) return res.status(400).json({ error: 'Unknown plan.' });

    let phone = String(req.body?.phone || '').replace(/[\s().-]/g, '');
    phone = phone.replace(/^\+?237/, '');
    if (!/^6\d{8}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid 9-digit Cameroon mobile number.' });

    // A new attempt supersedes older open ones (the provider stays the source of truth if the old one is paid).
    await db.execute({
      sql: `UPDATE payments SET status = 'cancelled', updated_at = ? WHERE user_id = ? AND status IN ('pending','processing')`,
      args: [Date.now(), user.id],
    });

    const id = crypto.randomUUID();
    const now = Date.now();
    await db.execute({
      sql: `INSERT INTO payments (id, user_id, plan, amount, currency, method, provider, phone_hint, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'moneyfusion', 'moneyfusion', ?, 'pending', ?, ?)`,
      args: [id, user.id, plan.key, plan.price, plan.currency, `***${phone.slice(-3)}`, now, now],
    });

    let started;
    try {
      started = await provider.collect({
        amount: plan.price, phone: `237${phone}`, planLabel: `Takamura Elite — ${plan.label}`,
        personalInfo: { paymentId: id, userId: user.id },
      });
    } catch (e) {
      console.error('[payment/start provider]', e.message);
      await db.execute({ sql: `UPDATE payments SET status = 'failed', updated_at = ? WHERE id = ?`, args: [Date.now(), id] });
      return res.status(502).json({ error: 'Payment could not be started. Please try again.' });
    }
    await db.execute({
      sql: `UPDATE payments SET provider_ref = ?, status = 'processing', updated_at = ? WHERE id = ? AND status = 'pending'`,
      args: [started.token, Date.now(), id],
    });
    // Unlike the previous provider, Money Fusion has no direct USSD push: the browser must be sent
    // to the hosted checkout page it returns. The frontend redirects to checkoutUrl, then polls
    // /api/payment/status/:id (also picked up automatically on return via /api/me's pendingPayment).
    res.json({ payment: publicPayment(await getPayment(id)), checkoutUrl: started.url });
  } catch (e) {
    console.error('[payment/start]', e.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Reflects the state recorded by the server (updated by the webhook or by a server-side check with the provider).
app.get('/api/payment/status/:id', limitPayStatus, async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Not authenticated.' });
    const id = String(req.params.id || '');
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid payment.' });
    let p = await getPayment(id);
    if (!p || Number(p.user_id) !== Number(user.id)) return res.status(404).json({ error: 'Payment not found.' });
    p = await reconcile(p);
    if (p.status === 'paid') await ensureSession(p.id);
    res.json(publicPayment(p));
  } catch (e) {
    console.error('[payment/status]', e.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Money Fusion webhook. Money Fusion does not publicly document a signature scheme for this payload,
// so — like the reconciliation logic above — it is NEVER trusted for the decision on its own: it only
// tells us which payment to re-check, and the transaction is then re-fetched from Money Fusion with our
// own API URL (checkPaymentStatus) and compared to our record (token, personal_Info, amount) in
// applyProviderTx(). Replays are harmless (compare-and-set in activatePayment).
app.post('/api/payment/moneyfusion/webhook', limitWebhook, async (req, res) => {
  try {
    if (!PAYMENTS_ENABLED) return res.status(503).json({ error: 'Unavailable.' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const token = cleanLine(body.tokenPay || body.token, 80);
    const piRaw = Array.isArray(body.personal_Info) ? body.personal_Info[0] : body.personal_Info;
    const paymentId = cleanLine(piRaw && piRaw.paymentId, 60);
    if (!token && !paymentId) return res.status(400).json({ error: 'Invalid payload.' });

    let p = null;
    if (UUID_RE.test(paymentId)) p = await getPayment(paymentId);
    if (!p && token) {
      const r = await db.execute({ sql: `SELECT * FROM payments WHERE provider_ref = ?`, args: [token] });
      p = r.rows[0] || null;
    }
    if (!p) return res.json({ ok: true }); // unknown to us: acknowledge, do nothing
    if (token && p.provider_ref && token !== p.provider_ref) return res.json({ ok: true });
    if (p.status !== 'paid') await reconcile(p, { force: true });
    res.json({ ok: true });
  } catch (e) {
    console.error('[webhook]', e.message);
    res.status(500).json({ error: 'Error.' }); // provider may retry
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
    const isFree = !!Number(user.is_free);
    const sess = await getAccessForUser(user);
    if (!sess) return res.status(403).json({ error: 'No active access. Please purchase a plan.' });

    const category = String(req.body?.category || '');
    const severity = String(req.body?.severity || 'Modérée');
    const waNumber = cleanLine(req.body?.waNumber, 200);
    const message = cleanText(req.body?.message, 5000);
    if (!category || !waNumber) return res.status(400).json({ error: 'Category and target are required.' });
    if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category.' });
    if (!SEVERITIES.includes(severity)) return res.status(400).json({ error: 'Invalid severity.' });
    if (!WA_TARGET_RE.test(waNumber)) return res.status(400).json({ error: 'Invalid WhatsApp number or link.' });

    if (!isFree) {
      const sentToday = await countRows(`SELECT COUNT(*) AS c FROM reports WHERE user_id = ? AND created_at > ?`, [user.id, Date.now() - 24 * 60 * 60 * 1000]);
      if (sentToday >= MAX_REPORTS_PER_DAY) return res.status(429).json({ error: 'Daily report limit reached.' });
    }

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
    const now = Date.now();
    const [u, pay, legacy, r, stats] = await Promise.all([
      db.execute(`SELECT id, email, verified, is_free, created_at FROM users ORDER BY created_at DESC LIMIT 200`),
      db.execute(`SELECT p.id, p.plan, p.amount, p.currency, p.method, p.provider_ref, p.status, p.created_at, p.paid_at, u.email
                  FROM payments p LEFT JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC LIMIT 200`),
      db.execute(`SELECT s.token, s.plan, s.price, s.payer_name, s.payer_phone, s.transaction_ref, s.created_at, u.email
                  FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE s.status = 'pending' ORDER BY s.created_at DESC LIMIT 100`),
      db.execute(`SELECT r.case_id, r.category, r.severity, r.wa_number, r.message, r.created_at, r.email_status, u.email
                  FROM reports r LEFT JOIN users u ON u.id = r.user_id ORDER BY r.created_at DESC LIMIT 200`),
      Promise.all([
        countRows(`SELECT COUNT(*) AS c FROM users`, []),
        countRows(`SELECT COUNT(DISTINCT user_id) AS c FROM sessions WHERE status = 'active' AND expires_at > ?`, [now]),
        countRows(`SELECT COUNT(*) AS c FROM payments WHERE status IN ('pending','processing')`, []),
        countRows(`SELECT COUNT(*) AS c FROM reports`, []),
        db.execute(`SELECT COALESCE(SUM(amount),0) AS c FROM payments WHERE status = 'paid'`).then((x) => Number(x.rows[0].c || 0)),
      ]),
    ]);
    const [totalUsers, activeSubs, pendingPay, totalReports, revenue] = stats;

    const nonce = crypto.randomBytes(16).toString('base64');
    res.set({
      'Content-Security-Policy':
        `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
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
.b-paid,.b-sent,.b-active{color:var(--ok);border-color:rgba(111,191,142,.35)}.b-failed,.b-cancelled,.b-expired{color:var(--er);border-color:rgba(217,115,107,.35)}.b-pending,.b-processing{color:var(--ac);border-color:rgba(201,166,107,.35)}
.act{font:inherit;font-size:12px;padding:5px 11px;border-radius:7px;border:1px solid var(--bd);background:var(--s2);color:var(--tx);cursor:pointer;margin-right:4px}.act:hover{border-color:var(--ac)}.act.no{color:var(--er)}.act:disabled{opacity:.5;cursor:wait}
h2{font-size:15px;margin:26px 0 10px;font-weight:600}p.note{color:var(--mu);margin:0 0 10px;font-size:13px}.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px}
section[hidden]{display:none}
</style>
<header><h1>TAKAMURA ELITE · ADMIN</h1>
<nav role="tablist" aria-label="Sections">
<button role="tab" aria-selected="true" data-tab="overview">Overview</button><button role="tab" aria-selected="false" data-tab="users">Users</button>
<button role="tab" aria-selected="false" data-tab="payments">Payments</button><button role="tab" aria-selected="false" data-tab="reports">Reports</button></nav></header>

<section id="t-overview">
<div class="grid">
<div class="card"><small>Total users</small><strong>${totalUsers}</strong></div>
<div class="card"><small>Active subscriptions</small><strong>${activeSubs}</strong></div>
<div class="card"><small>Pending payments</small><strong>${pendingPay}</strong></div>
<div class="card"><small>Reports</small><strong>${totalReports}</strong></div>
<div class="card"><small>Confirmed revenue</small><strong>${money(revenue)} <span style="font-size:13px;color:var(--mu)">${esc(CURRENCY_LABEL)}</span></strong></div>
</div>
<p class="note">Payments are confirmed automatically by the provider (webhook + server-side verification). ${PAYMENTS_ENABLED ? '' : '<strong style="color:var(--er)">MONEYFUSION_API_URL is not set: payments are disabled.</strong>'}</p>
</section>

<section id="t-users" hidden><div class="scroll"><table><tr><th>ID</th><th>Email</th><th>Verified</th><th>Free access</th><th>Created</th><th></th></tr>
${u.rows.map((x) => `<tr><td>${esc(x.id)}</td><td>${esc(x.email)}</td><td>${x.verified ? badge('active') : badge('pending')}</td><td>${Number(x.is_free) ? badge('active') : '—'}</td><td>${esc(fmtDate(x.created_at))}</td><td><button class="act" data-toggle-free="${esc(x.id)}" data-free-state="${Number(x.is_free) ? 1 : 0}">${Number(x.is_free) ? 'Revoke free access' : 'Grant free access'}</button><button class="act" data-reset-user="${esc(x.id)}">Reset password</button><button class="act no" data-delete-user="${esc(x.id)}">Delete</button></td></tr>`).join('')}</table></div></section>

<section id="t-payments" hidden>
<div class="scroll"><table><tr><th>User</th><th>Plan</th><th>Amount</th><th>Method</th><th>Transaction</th><th>Status</th><th>Date</th><th></th></tr>
${pay.rows.map((x) => `<tr><td>${esc(x.email)}</td><td>${esc(x.plan)}</td><td>${esc(money(x.amount))} ${esc(x.currency)}</td><td>${esc(x.method)}</td><td class="mono">${esc(x.provider_ref || '—')}</td><td>${badge(x.status)}</td><td>${esc(fmtDate(x.paid_at || x.created_at))}</td><td>${
      x.status !== 'paid' && x.provider_ref ? `<button class="act" data-recheck="${esc(x.id)}">Re-check</button>` : ''}</td></tr>`).join('')}</table></div>
<h2>Legacy manual requests (${legacy.rows.length})</h2>
<p class="note">Old manual-declaration requests only. Kept as an exceptional support tool; new payments never appear here.</p>
<div class="scroll"><table><tr><th>Created</th><th>User</th><th>Plan</th><th>Price</th><th>Name</th><th>Phone</th><th>Ref</th><th></th></tr>
${legacy.rows.map((x) => `<tr><td>${esc(fmtDate(x.created_at))}</td><td>${esc(x.email)}</td><td>${esc(x.plan)}</td><td>${esc(x.price)}</td><td>${esc(x.payer_name)}</td><td>${esc(x.payer_phone)}</td><td>${esc(x.transaction_ref)}</td><td><button class="act" data-action="activate" data-token="${esc(x.token)}">Approve</button><button class="act no" data-action="reject" data-token="${esc(x.token)}">Reject</button></td></tr>`).join('')}</table></div>
</section>

<section id="t-reports" hidden><div class="scroll"><table><tr><th>Date</th><th>User</th><th>Case</th><th>Category</th><th>Severity</th><th>Target</th><th>Message</th><th>Emails</th></tr>
${r.rows.map((x) => `<tr><td>${esc(fmtDate(x.created_at))}</td><td>${esc(x.email)}</td><td class="mono">${esc(x.case_id)}</td><td>${esc(x.category)}</td><td>${esc(x.severity)}</td><td>${esc(x.wa_number)}</td><td class="wrap">${esc(String(x.message || '').slice(0, 200))}</td><td>${esc(x.email_status)}</td></tr>`).join('')}</table></div></section>

<script nonce="${nonce}">
const tabs=[...document.querySelectorAll('[data-tab]')];
function show(n){tabs.forEach(t=>t.setAttribute('aria-selected',String(t.dataset.tab===n)));['overview','users','payments','reports'].forEach(k=>document.getElementById('t-'+k).hidden=k!==n);}
tabs.forEach(t=>t.addEventListener('click',()=>show(t.dataset.tab)));
async function post(url,body){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'takamura-admin'},body:JSON.stringify(body)});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Error');return d;}
document.addEventListener('click',async e=>{
  const b=e.target.closest('button.act');if(!b)return;
  if(b.dataset.action==='reject'&&!confirm('Reject this request?'))return;
  if(b.dataset.action==='activate'&&!confirm('Grant access manually? Use only for exceptional support cases.'))return;
  if(b.dataset.deleteUser&&!confirm('Delete this user permanently? This cannot be undone. Their reports and payment history are kept for records but will no longer show a linked account.'))return;
  if(b.dataset.resetUser&&!confirm('Generate a new temporary password for this user? Their current sessions will be signed out.'))return;
  if(b.dataset.toggleFree&&!confirm(b.dataset.freeState==='1'?'Revoke free unlimited access for this user?':'Grant free unlimited access to this user? They will no longer need to pay.'))return;
  b.disabled=true;
  try{
    if(b.dataset.recheck)await post('/admin/payments/recheck',{id:b.dataset.recheck});
    else if(b.dataset.deleteUser){await post('/admin/users/delete',{id:b.dataset.deleteUser});location.reload();return;}
    else if(b.dataset.toggleFree){await post('/admin/users/set-free',{id:b.dataset.toggleFree,isFree:b.dataset.freeState!=='1'});location.reload();return;}
    else if(b.dataset.resetUser){const d=await post('/admin/users/reset-password',{id:b.dataset.resetUser});alert((d.emailed?'Emailed to the user.\\n\\n':'Could not email the user — share this manually.\\n\\n')+'Temporary password: '+d.tempPassword);b.disabled=false;return;}
    else await post('/admin/sessions/decision',{token:b.dataset.token,action:b.dataset.action});
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

app.post('/admin/users/set-free', limitAdmin, adminAuth, requireAdminXhr, async (req, res) => {
  try {
    const id = Number(req.body?.id);
    const isFree = req.body?.isFree ? 1 : 0;
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid request.' });
    const r = await db.execute({ sql: `UPDATE users SET is_free = ? WHERE id = ?`, args: [isFree, id] });
    if (!rowsAffected(r)) return res.status(404).json({ error: 'User not found.' });
    res.json({ ok: true, isFree: !!isFree });
  } catch (e) {
    console.error('[admin set-free]', e.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.post('/admin/payments/recheck', limitAdmin, adminAuth, requireAdminXhr, async (req, res) => {
  try {
    const id = String(req.body?.id || '');
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid request.' });
    const p = await getPayment(id);
    if (!p) return res.status(404).json({ error: 'Payment not found.' });
    const after = await reconcile(p, { force: true });
    res.json({ ok: true, status: after.status });
  } catch (e) {
    console.error('[admin recheck]', e.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.post('/admin/sessions/decision', limitAdmin, adminAuth, requireAdminXhr, async (req, res) => {
  try {
    const token = String(req.body?.token || '');
    const action = String(req.body?.action || '');
    if (!token || !['activate', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid request.' });
    const r = await db.execute({
      sql: `SELECT s.token, s.plan, s.status, u.email FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
      args: [token],
    });
    const s = r.rows && r.rows[0];
    if (!s) return res.status(404).json({ error: 'Session not found.' });
    if (s.status !== 'pending') return res.status(409).json({ error: 'Already processed.' });
    if (action === 'reject') {
      await db.execute({ sql: `UPDATE sessions SET status = 'rejected' WHERE token = ? AND status = 'pending'`, args: [token] });
      return res.json({ ok: true });
    }
    const plan = PLANS[s.plan];
    if (!plan) return res.status(400).json({ error: 'Unknown plan.' });
    const now = Date.now();
    const expiresAt = now + plan.durationMs;
    await db.execute({
      sql: `UPDATE sessions SET status = 'active', created_at = ?, expires_at = ? WHERE token = ? AND status = 'pending'`,
      args: [now, expiresAt, token],
    });
    if (s.email) sendAccessActivatedEmail(s.email, plan.label, expiresAt).catch(() => {});
    res.json({ ok: true, expiresAt });
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
  await ensureAdminUserAccount();
  await sweepPayments();
  setInterval(sweepPayments, 60 * 1000).unref();
  app.listen(PORT, () => console.log(`[HTTP] Takamura Elite listening on ${PORT} (payments ${PAYMENTS_ENABLED ? 'ENABLED' : 'DISABLED'})`));
})().catch((e) => {
  console.error('[BOOT] Startup failed:', e && e.message);
  process.exit(1);
});
