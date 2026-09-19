'use strict';

/* ============================================================================
   TAKAMURA ELITE — index.js (version corrigée)
   Comptes + vérification email (code 6 chiffres) + paiement (validation admin)
   + signalements.

   Configuration en dur (voir bloc CONFIG et createClient ci-dessous).
   index.js et index.html sont à la racine ; seule la route « / » sert
   index.html, donc index.js n'est jamais téléchargeable.
   ============================================================================ */

const express    = require('express');
const crypto     = require('crypto');
const path       = require('path');
const { promisify } = require('util');
const { createClient } = require('@tursodatabase/serverless/compat');
let Stripe = null;
try { Stripe = require('stripe'); } catch (_) { /* installé via npm install (voir package.json) */ }

const scrypt = promisify(crypto.scrypt);

/* ========================== CONFIG (valeurs en dur) ========================== */
const PORT           = process.env.PORT || 3000;   // fourni automatiquement par la plupart des hébergeurs

const EMAIL_USER     = 'yhrespon@gmail.com';   // expéditeur vérifié dans Brevo
// Envoi d'emails via l'API HTTPS de Brevo (Railway bloque le SMTP sur Trial/Hobby/Free).
// Clé API Brevo : Settings > SMTP & API > API Keys (elle commence par « xkeysib- »).
const BREVO_API_KEY  = process.env.BREVO_API_KEY;
const ADMIN_EMAIL    = 'yenohyenoh209@gmail.com';
const ADMIN_PASSWORD = 'TAKAMURA-ADMIN-2026';

// true uniquement si l'hébergeur place un reverse proxy devant l'app (Render, Railway, Nginx…)
const TRUST_PROXY    = false;

const CODE_TTL_MS       = 15 * 60 * 1000;        // code valable 15 min
const CODE_COOLDOWN_MS  = 60 * 1000;             // 1 code / minute / compte
const MAX_CODE_ATTEMPTS = 5;                     // essais max par code
const TOKEN_TTL_MS      = 30 * 24 * 60 * 60 * 1000; // connexion valable 30 jours
const MAX_REPORTS_PER_DAY = 20;                  // signalements / utilisateur / 24 h
const MAX_PENDING_PER_USER = 3;                  // paiements en attente / utilisateur

const PAYMENT_INFO = {
  orange_money: '+237 690 000 000',   // ← à modifier
  mtn_momo:     '+237 680 000 000',   // ← à modifier
  beneficiary:  'Takamura Elite',
};

const PLANS = {
  day:  { key: 'day',  label: 'Accès 24 heures', price: 1000, durationMs: 24 * 60 * 60 * 1000, currency: 'FCFA' },
  week: { key: 'week', label: 'Accès 1 semaine', price: 2500, durationMs: 7 * 24 * 60 * 60 * 1000, currency: 'FCFA' },
};

const WHATSAPP_EMAILS = [
  'support@support.whatsapp.com',
  'support@whatsapp.com',
  'android@support.whatsapp.com',
  'smb@support.whatsapp.com',
  'accessibility@support.whatsapp.com',
];

const CATEGORIES = [
  'Fraude / Arnaque',
  "Pédocriminalité / Exploitation d'enfants",
  'Spam',
  'Vente illégale',
  'Autre',
];
const SEVERITIES = ['Faible', 'Modérée', 'Élevée', 'Critique — mineurs impliqués'];

/* ========================== TURSO ========================== */
const db = createClient({
  url: 'libsql://yh-yhrespon77.aws-us-east-1.turso.io',
  authToken: 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODk2MTQyNTgsImlkIjoiMDFhMGFkM2EtMDAwMS03NGE3LWFjMmMtZDIzZDQzNzQwZDJmIiwia2lkIjoicTIzMHlLZ1lJRlYtakt2czZPTmttNkpMdk1PTGt1TzFQcm5wamdka3c4VSIsInJpZCI6ImNhY2YzZWU1LTM3ZWMtNGY5My05N2ZkLTQwMGVhODIwOGFhYyJ9.XCpmnB8zB0r_F7YHoUoJIcOHVhCCKAzWo9F2vUY45eGorwJuaV4QI--1DqhF-eOzq3djWsfnW0dYv5OjmIwMAg',
});

async function ensureColumn(table, column, definition) {
  try { await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`); }
  catch (_) { /* existe déjà */ }
}

async function tableColumns(table) {
  try {
    const r = await db.execute(`PRAGMA table_info(${table})`);
    return (r.rows || []).map((x) => String(x.name));
  } catch (_) { return []; }
}

// Si une ancienne table « users » (autre schéma : sans password_hash, etc.) existe déjà,
// on la met de côté (renommée, données conservées) et on repart d'une table propre.
async function quarantineLegacyUsers() {
  const cols = await tableColumns('users');
  if (!cols.length) return; // table absente : sera créée normalement
  const required = ['id', 'email', 'password_hash', 'created_at'];
  const missing = required.filter((c) => !cols.includes(c));
  if (!missing.length) return;
  const legacy = `users_legacy_${Date.now()}`;
  console.warn(`[DB] Ancienne table users (colonnes : ${cols.join(', ')}) — manque : ${missing.join(', ')}. Renommée en ${legacy}.`);
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
  // Compat si la table existait déjà sans ces colonnes :
  await ensureColumn('users', 'verified', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('users', 'verification_code', 'TEXT');
  await ensureColumn('users', 'verification_expires', 'INTEGER');
  await ensureColumn('users', 'verification_attempts', 'INTEGER NOT NULL DEFAULT 0');

  // NB : les tokens sont désormais stockés HASHÉS (sha256). Les anciens tokens
  // en clair ne correspondent plus : les utilisateurs devront se reconnecter.
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
  // Compat : si ces tables existaient déjà (anciennes versions) sans certaines
  // colonnes, on les ajoute AVANT de créer les index (sinon « no such column »).
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
  // Paiement réel (Stripe / CinetPay) : distingue du flux manuel existant.
  await ensureColumn('sessions', 'gateway', "TEXT NOT NULL DEFAULT 'manual'");
  await ensureColumn('sessions', 'external_ref', 'TEXT');

  // Paramètres du Dashboard PRO (une seule ligne, JSON) : profil, entreprise,
  // moyens de paiement, notifications, apparence, produits.
  await db.execute(`CREATE TABLE IF NOT EXISTS dashboard_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);

  await ensureColumn('reports', 'user_id', 'INTEGER');
  await ensureColumn('reports', 'case_id', 'TEXT');
  await ensureColumn('reports', 'category', 'TEXT');
  await ensureColumn('reports', 'severity', 'TEXT');
  await ensureColumn('reports', 'wa_number', 'TEXT');
  await ensureColumn('reports', 'message', 'TEXT');
  await ensureColumn('reports', 'created_at', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('reports', 'email_status', 'TEXT');

  // Les index sont un bonus de performance : un échec ne doit jamais empêcher le démarrage.
  for (const sql of [
    `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_reports_user ON reports(user_id, created_at)`,
  ]) {
    try { await db.execute(sql); }
    catch (e) { console.warn('[DB] Index ignoré :', e.message); }
  }

  // Ménage : tokens de connexion expirés
  await db.execute({ sql: `DELETE FROM auth_tokens WHERE created_at < ?`, args: [Date.now() - TOKEN_TTL_MS] });
  console.log('[DB] Tables prêtes.');
}

/* ========================== HELPERS ========================== */
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

// Texte sur une seule ligne (évite l'injection d'en-têtes dans les emails)
function cleanLine(v, max) {
  return String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}
// Texte multi-lignes (retours à la ligne conservés)
function cleanText(v, max) {
  return String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
}

/* ---------- Limiteur de débit en mémoire (par IP) ---------- */
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
      return res.status(429).json({ error: 'Trop de requêtes. Réessayez plus tard.' });
    }
    next();
  };
}
const MIN = 60 * 1000;
const limitGlobal   = rateLimit({ windowMs: 15 * MIN, max: 600 });
const limitRegister = rateLimit({ windowMs: 60 * MIN, max: 10 });
const limitLogin    = rateLimit({ windowMs: 15 * MIN, max: 20 });
const limitVerify   = rateLimit({ windowMs: 15 * MIN, max: 20 });
const limitResend   = rateLimit({ windowMs: 15 * MIN, max: 5 });
const limitPayment  = rateLimit({ windowMs: 60 * MIN, max: 10 });
const limitReport   = rateLimit({ windowMs: 60 * MIN, max: 20 });
const limitAdmin    = rateLimit({ windowMs: 15 * MIN, max: 120 });

/* ---------- Mots de passe (scrypt asynchrone) ---------- */
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
// Hash factice : évite de révéler par le temps de réponse si un email existe
const DUMMY_HASH = (() => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync('dummy-password', salt, 64).toString('hex')}`;
})();

/* ---------- Codes de vérification ---------- */
function generateCode() {
  return String(crypto.randomInt(100000, 1000000)); // 6 chiffres, CSPRNG
}
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

/* ---------- Tokens de connexion (stockés hashés, avec expiration) ---------- */
async function getUserFromToken(req) {
  const token = req.header('X-User-Token') || '';
  if (!token || token.length > 200) return null;
  const r = await db.execute({
    sql: `SELECT u.id, u.email, u.verified
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
  return token; // la valeur en clair n'est jamais stockée
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

async function countRows(sql, args) {
  const r = await db.execute({ sql, args });
  return Number(r.rows[0]?.c || 0);
}

/* ========================== PARAMÈTRES DU DASHBOARD ========================== */
const DEFAULT_SETTINGS = {
  profil: { nom: 'Admin', email: ADMIN_EMAIL },
  entreprise: { nom: 'Takamura Elite', adresse: '', devise: 'FCFA' },
  paiement: {
    mode: 'test', // 'test' | 'live'
    stripe:   { enabled: false, publicKey: '', secretKey: '', webhookSecret: '' },
    cinetpay: { enabled: false, siteId: '', apiKey: '', secretKey: '', channels: ['MOBILE_MONEY'] },
    mtn_momo:     { enabled: true },
    orange_money: { enabled: true },
    wave:         { enabled: false },
  },
  notifications: { email: true, sms: false, webhook: false, webhookUrl: '' },
  apparence: { theme: 'dark', accent: 'violet', langue: 'FR' },
  produits: {
    day:  { label: PLANS.day.label,  price: PLANS.day.price },
    week: { label: PLANS.week.label, price: PLANS.week.price },
  },
};

function deepMerge(base, patch) {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return patch === undefined ? base : patch;
  }
  const out = { ...base };
  for (const k of Object.keys(patch)) {
    out[k] = deepMerge(base ? base[k] : undefined, patch[k]);
  }
  return out;
}

let settingsCache = null;
async function getSettings() {
  if (settingsCache) return settingsCache;
  const r = await db.execute(`SELECT data FROM dashboard_settings WHERE id = 1`);
  const row = r.rows && r.rows[0];
  settingsCache = row ? deepMerge(DEFAULT_SETTINGS, JSON.parse(row.data)) : { ...DEFAULT_SETTINGS };
  return settingsCache;
}
async function saveSettings(patch) {
  const current = await getSettings();
  const merged = deepMerge(current, patch);
  await db.execute({
    sql: `INSERT INTO dashboard_settings (id, data, updated_at) VALUES (1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    args: [JSON.stringify(merged), Date.now()],
  });
  settingsCache = merged;
  return merged;
}
// Prix/labels des plans éventuellement redéfinis depuis les Paramètres > Produits.
async function getEffectivePlans() {
  const s = await getSettings();
  const out = {};
  for (const key of Object.keys(PLANS)) {
    const override = s.produits && s.produits[key];
    out[key] = {
      ...PLANS[key],
      label: (override && override.label) || PLANS[key].label,
      price: (override && Number(override.price) > 0) ? Number(override.price) : PLANS[key].price,
    };
  }
  return out;
}

/* ========================== MAILER ========================== */
// L'adresse EMAIL_USER doit être ajoutée ET vérifiée comme « expéditeur » dans Brevo
// (Senders, Domains & Dedicated IPs > Senders).
async function sendViaBrevo({ to, subject, text, html }) {
  if (String(BREVO_API_KEY).startsWith('REMPLACER')) {
    throw new Error('BREVO_API_KEY non renseignée dans index.js');
  }
  const payload = {
    sender: { name: 'Takamura Elite', email: EMAIL_USER },
    to: [{ email: to }],
    subject,
    textContent: text,
  };
  if (html) payload.htmlContent = html;

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Brevo ${res.status} : ${detail.slice(0, 300)}`);
  }
  return res.json();
}
const mailer = { sendMail: sendViaBrevo };   // même appel qu'avant : mailer.sendMail({ to, subject, text, html })
const FROM = 'Takamura Elite';               // conservé pour compatibilité (ignoré par Brevo)

async function sendVerificationEmail(email, code) {
  const minutes = Math.round(CODE_TTL_MS / 60000);
  const subject = `Takamura Elite — Code de vérification : ${code}`;
  const text =
    `Bienvenue chez Takamura Elite.\n\n` +
    `Votre code de vérification est :\n\n` +
    `    ${code}\n\n` +
    `Ce code est valable ${minutes} minutes.\n` +
    `Si vous n'êtes pas à l'origine de cette inscription, ignorez cet email.\n\n` +
    `— Takamura Elite`;
  const html = `
    <div style="font-family:monospace;background:#0b0d10;color:#EDE8DC;padding:28px;border-radius:6px">
      <h2 style="color:#C8A54B;font-family:Georgia,serif;margin:0 0 12px">Takamura Elite</h2>
      <p style="margin:0 0 18px">Votre code de vérification :</p>
      <div style="display:inline-block;font-size:34px;letter-spacing:.3em;font-weight:700;color:#F1D98F;
                  background:#15181e;padding:14px 22px;border:1px solid rgba(200,165,75,.4);border-radius:4px">
        ${code}
      </div>
      <p style="margin:20px 0 0;color:#8B8478;font-size:12px">
        Valable ${minutes} minutes. Si vous n'êtes pas à l'origine de cette inscription, ignorez cet email.
      </p>
    </div>`;
  return mailer.sendMail({ from: FROM, to: email, subject, text, html });
}

async function sendWhatsAppReport({ caseId, category, severity, waNumber, message, destination }) {
  const subject = `Signalement WhatsApp — ${category} — ${waNumber}`;
  let body = `${caseId}\n`;
  body += `Catégorie : ${category}\n`;
  body += `Gravité : ${severity}\n`;
  body += `Numéro / lien WhatsApp signalé : ${waNumber}\n\n`;
  if (message) body += `Message litigieux (copié par le déclarant) :\n${message}\n\n`;
  body += `Merci d'examiner ce compte pour violation des conditions d'utilisation WhatsApp.\n`;
  return mailer.sendMail({ from: FROM, to: destination, subject, text: body });
}

async function sendAdminNotification(info) {
  try {
    await mailer.sendMail({
      from: FROM,
      to: ADMIN_EMAIL,
      subject: `[Takamura] Paiement à valider — ${info.planLabel} (${info.price} ${info.currency})`,
      text:
        `Nouveau paiement déclaré, EN ATTENTE DE VALIDATION (page /admin).\n\n` +
        `Compte    : ${info.email}\n` +
        `Plan      : ${info.planLabel}\n` +
        `Prix      : ${info.price} ${info.currency}\n` +
        `Nom       : ${info.name}\n` +
        `Téléphone : ${info.phone}\n` +
        `Réf. tx   : ${info.transactionRef || '(non fourni)'}\n`,
    });
  } catch (e) { console.error('[MAIL admin]', e.message); }
}

// Active ou rejette une session « pending » — utilisé par /admin, /dashboard
// (validation manuelle) et par les webhooks Stripe / CinetPay (paiement réel).
async function decideSession(token, action) {
  const r = await db.execute({
    sql: `SELECT s.token, s.plan, s.status, u.email
          FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
    args: [token],
  });
  const s = r.rows && r.rows[0];
  if (!s) return { error: 'Session introuvable.', code: 404 };
  if (s.status !== 'pending') return { error: 'Cette demande a déjà été traitée.', code: 409 };

  if (action === 'reject') {
    await db.execute({ sql: `UPDATE sessions SET status = 'rejected' WHERE token = ? AND status = 'pending'`, args: [token] });
    return { ok: true };
  }

  const plans = await getEffectivePlans();
  const plan = plans[s.plan];
  if (!plan) return { error: 'Plan inconnu.', code: 400 };
  const now = Date.now();
  const expiresAt = now + plan.durationMs;
  await db.execute({
    sql: `UPDATE sessions SET status = 'active', created_at = ?, expires_at = ? WHERE token = ? AND status = 'pending'`,
    args: [now, expiresAt, token],
  });
  if (s.email) sendAccessActivatedEmail(s.email, plan.label, expiresAt).catch(() => {});
  return { ok: true, expiresAt };
}

async function sendAccessActivatedEmail(email, planLabel, expiresAt) {
  try {
    await mailer.sendMail({
      from: FROM,
      to: email,
      subject: 'Takamura Elite — Votre accès est activé',
      text:
        `Votre paiement a été validé.\n\n` +
        `Plan : ${planLabel}\n` +
        `Expire le : ${new Date(expiresAt).toLocaleString('fr-FR', { timeZone: 'Africa/Douala' })}\n\n` +
        `— Takamura Elite`,
    });
  } catch (e) { console.error('[MAIL activation]', e.message); }
}

/* ========================== APP ========================== */
const app = express();
app.disable('x-powered-by');
// Voir TRUST_PROXY en haut du fichier (reverse proxy de l'hébergeur).
if (TRUST_PROXY) app.set('trust proxy', 1);

app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  next();
});
// Le webhook Stripe doit recevoir le corps BRUT (non parsé) pour vérifier la
// signature — il est donc déclaré avant express.json(), sur son propre chemin.
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const s = await getSettings();
    const cfg = s.paiement.stripe;
    if (!cfg.enabled || !cfg.secretKey || !Stripe) return res.status(400).send('Stripe désactivé.');
    const stripe = new Stripe(cfg.secretKey);

    let event;
    try {
      event = cfg.webhookSecret
        ? stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], cfg.webhookSecret)
        : JSON.parse(req.body.toString('utf8'));
    } catch (e) {
      console.error('[webhook stripe] signature invalide', e.message);
      return res.status(400).send(`Webhook invalide : ${e.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const token = session.metadata && session.metadata.session_token;
      if (token) {
        await db.execute({ sql: `UPDATE sessions SET external_ref = ? WHERE token = ?`, args: [session.id, token] });
        const result = await decideSession(token, 'activate');
        if (result.error) console.error('[webhook stripe] activation échouée :', result.error);
      }
    }
    res.json({ received: true });
  } catch (e) {
    console.error('[webhook stripe]', e);
    res.status(500).send('Erreur serveur.');
  }
});

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' })); // notifications CinetPay (x-www-form-urlencoded)
app.use('/api', limitGlobal);

// index.html est à la racine, à côté de index.js : on ne sert QUE ce fichier
// (pas express.static(__dirname), sinon index.js serait téléchargeable).
const INDEX_HTML = path.join(__dirname, 'index.html');
app.get(['/', '/index.html'], (_req, res) => res.sendFile(INDEX_HTML));

app.get('/api/config', async (_req, res) => {
  try {
    const s = await getSettings();
    const plans = await getEffectivePlans();
    const gateways = [];
    if (s.paiement.stripe.enabled && s.paiement.stripe.publicKey) gateways.push('stripe');
    if (s.paiement.cinetpay.enabled && s.paiement.cinetpay.siteId) {
      if (s.paiement.mtn_momo.enabled) gateways.push('mtn_momo');
      if (s.paiement.orange_money.enabled) gateways.push('orange_money');
      if (s.paiement.wave.enabled) gateways.push('wave');
    }
    res.json({
      plans: Object.values(plans).map((p) => ({ key: p.key, label: p.label, price: p.price, currency: p.currency })),
      payment: PAYMENT_INFO,
      whatsappEmails: WHATSAPP_EMAILS,
      codeTtlMinutes: Math.round(CODE_TTL_MS / 60000),
      gateways,          // moyens de paiement réels activés (en plus du virement manuel, toujours dispo)
      currency: s.entreprise.devise,
      mode: s.paiement.mode,
    });
  } catch (e) {
    console.error('[config]', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/* ============================================================
   AUTH : REGISTER (envoie le code) / VERIFY / RESEND / LOGIN / LOGOUT / ME
   ============================================================ */

app.post('/api/auth/register', limitRegister, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis.' });
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email invalide.' });
    if (password.length < 8) return res.status(400).json({ error: 'Mot de passe trop court (8 caractères min).' });
    if (password.length > 128) return res.status(400).json({ error: 'Mot de passe trop long (128 caractères max).' });

    const existing = await db.execute({
      sql: `SELECT id, verified, verification_expires FROM users WHERE email = ?`,
      args: [email],
    });

    if (existing.rows.length) {
      const u = existing.rows[0];
      if (u.verified) return res.status(409).json({ error: 'Cet email est déjà utilisé.' });
      // Compte non vérifié → on met à jour le mot de passe et on renvoie un code (avec délai mini)
      await db.execute({
        sql: `UPDATE users SET password_hash = ? WHERE id = ?`,
        args: [await hashPassword(password), u.id],
      });
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
    console.error('[register]', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

app.post('/api/auth/verify', limitVerify, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const code = String(req.body?.code || '').trim();
    if (!email || !code) return res.status(400).json({ error: 'Email et code requis.' });
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Code incorrect.' });

    // On compte la tentative AVANT de comparer (atomique, résiste aux requêtes parallèles)
    await db.execute({
      sql: `UPDATE users SET verification_attempts = verification_attempts + 1 WHERE email = ? AND verified = 0`,
      args: [email],
    });

    const r = await db.execute({
      sql: `SELECT id, email, verified, verification_code, verification_expires, verification_attempts
            FROM users WHERE email = ?`,
      args: [email],
    });
    const user = r.rows && r.rows[0];
    // Réponse générique : ne révèle pas si le compte existe
    if (!user || user.verified) return res.status(400).json({ error: 'Code incorrect ou expiré.' });

    if (Number(user.verification_attempts) > MAX_CODE_ATTEMPTS) {
      return res.status(429).json({ error: 'Trop d\'essais. Demandez un nouveau code.' });
    }
    if (!user.verification_expires || Date.now() > Number(user.verification_expires)) {
      return res.status(400).json({ error: 'Code expiré. Demandez un nouveau code.' });
    }
    if (!user.verification_code || !safeEqual(user.verification_code, code)) {
      return res.status(400).json({ error: 'Code incorrect.' });
    }

    await db.execute({
      sql: `UPDATE users SET verified = 1, verification_code = NULL, verification_expires = NULL, verification_attempts = 0
            WHERE id = ?`,
      args: [user.id],
    });

    const token = await issueToken(user.id);
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (e) {
    console.error('[verify]', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

app.post('/api/auth/resend', limitResend, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email requis.' });

    const r = await db.execute({
      sql: `SELECT id, verified, verification_expires FROM users WHERE email = ?`,
      args: [email],
    });
    const user = r.rows && r.rows[0];
    // Réponse identique dans tous les cas (pas d'énumération de comptes)
    if (user && !user.verified && !codeIssuedRecently(user)) {
      await issueVerificationCode(user.id, email);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('[resend]', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

app.post('/api/auth/login', limitLogin, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis.' });
    if (password.length > 128) return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });

    const r = await db.execute({
      sql: `SELECT id, email, password_hash, verified, verification_expires FROM users WHERE email = ?`,
      args: [email],
    });
    const user = r.rows && r.rows[0];
    const passwordOk = await verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !passwordOk) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
    }

    if (!user.verified) {
      if (!codeIssuedRecently(user)) await issueVerificationCode(user.id, email);
      return res.status(403).json({
        error: 'Compte non vérifié. Un code de vérification vous a été envoyé.',
        needsVerification: true,
        email,
      });
    }

    const token = await issueToken(user.id);
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (e) {
    console.error('[login]', e);
    res.status(500).json({ error: 'Erreur serveur.' });
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
    if (!user) return res.status(401).json({ error: 'Non authentifié.' });
    const sess = await getActiveSession(user.id);
    const pending = sess ? 0 : await countRows(
      `SELECT COUNT(*) AS c FROM sessions WHERE user_id = ? AND status = 'pending'`, [user.id]);
    res.json({
      user: { id: user.id, email: user.email },
      hasAccess: !!sess,
      pending: pending > 0,
      access: sess ? { plan: sess.plan, expiresAt: Number(sess.expires_at) } : null,
    });
  } catch (e) {
    console.error('[me]', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/* ============================================================
   PAIEMENT — déclaration « en attente », activation par l'admin
   ============================================================ */

app.post('/api/payment/start', limitPayment, async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Connectez-vous d\'abord.' });
    if (!user.verified) return res.status(403).json({ error: 'Compte non vérifié.' });

    const { plan } = req.body || {};
    const name = cleanLine(req.body?.name, 80);
    const phone = cleanLine(req.body?.phone, 25);
    const transactionRef = cleanLine(req.body?.transactionRef, 60);

    const p = Object.prototype.hasOwnProperty.call(PLANS, plan) ? PLANS[plan] : null;
    if (!p) return res.status(400).json({ error: 'Plan inconnu.' });
    if (!name || !phone) return res.status(400).json({ error: 'Nom et téléphone requis.' });
    if (!/^\+?[0-9 ().-]{8,20}$/.test(phone)) return res.status(400).json({ error: 'Numéro de téléphone invalide.' });
    if (transactionRef && !/^[A-Za-z0-9._\- ]+$/.test(transactionRef)) {
      return res.status(400).json({ error: 'Référence de transaction invalide.' });
    }

    const pending = await countRows(
      `SELECT COUNT(*) AS c FROM sessions WHERE user_id = ? AND status = 'pending'`, [user.id]);
    if (pending >= MAX_PENDING_PER_USER) {
      return res.status(429).json({ error: 'Vous avez déjà des paiements en attente de validation.' });
    }
    if (transactionRef) {
      const used = await countRows(
        `SELECT COUNT(*) AS c FROM sessions WHERE transaction_ref = ?`, [transactionRef]);
      if (used > 0) return res.status(409).json({ error: 'Cette référence de transaction a déjà été utilisée.' });
    }

    const token = crypto.randomBytes(24).toString('hex');
    const now = Date.now();

    // Statut « pending » : AUCUN accès tant que l'admin n'a pas validé le paiement.
    // expires_at est recalculé à l'activation.
    await db.execute({
      sql: `INSERT INTO sessions
            (token, user_id, plan, price, payer_name, payer_phone, transaction_ref, status, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      args: [token, user.id, p.key, p.price, name, phone, transactionRef, now, now + p.durationMs],
    });

    sendAdminNotification({
      email: user.email, planLabel: p.label, price: p.price, currency: p.currency,
      name, phone, transactionRef,
    }).catch(() => {});

    res.json({ plan: p.key, status: 'pending' });
  } catch (e) {
    console.error('[payment/start]', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/* ============================================================
   PAIEMENT RÉEL — Stripe (carte) et CinetPay (MTN MoMo / Orange Money / Wave)
   Le moyen utilisé dépend des toggles enregistrés dans Paramètres > Paiement.
   Contrairement au flux manuel ci-dessus (validation admin), l'activation est
   automatique dès la confirmation du paiement par le webhook du fournisseur.
   ============================================================ */

app.post('/api/checkout', limitPayment, async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Connectez-vous d\'abord.' });
    if (!user.verified) return res.status(403).json({ error: 'Compte non vérifié.' });

    const s = await getSettings();
    const cfg = s.paiement.stripe;
    if (!cfg.enabled || !cfg.secretKey || !Stripe) return res.status(400).json({ error: 'Le paiement par carte n\'est pas activé.' });

    const plans = await getEffectivePlans();
    const plan = plans[String(req.body?.plan || '')];
    if (!plan) return res.status(400).json({ error: 'Plan inconnu.' });

    const token = crypto.randomBytes(24).toString('hex');
    const now = Date.now();
    await db.execute({
      sql: `INSERT INTO sessions
            (token, user_id, plan, price, payer_name, payer_phone, transaction_ref, status, created_at, expires_at, gateway)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 'stripe')`,
      args: [token, user.id, plan.key, plan.price, user.email, '', null, now, now + plan.durationMs],
    });

    const stripe = new Stripe(cfg.secretKey);
    const origin = req.get('origin') || `${req.protocol}://${req.get('host')}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: user.email,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd', // Stripe ne traite pas le FCFA : montant en USD/EUR selon votre configuration Stripe.
          unit_amount: Math.round(plan.price * 100),
          product_data: { name: plan.label },
        },
      }],
      metadata: { session_token: token },
      success_url: `${origin}/?paiement=succes`,
      cancel_url: `${origin}/?paiement=annule`,
    });

    await db.execute({ sql: `UPDATE sessions SET external_ref = ? WHERE token = ?`, args: [session.id, token] });
    res.json({ url: session.url });
  } catch (e) {
    console.error('[checkout]', e);
    res.status(500).json({ error: 'Erreur lors de la création du paiement.' });
  }
});

app.post('/api/cinetpay', limitPayment, async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Connectez-vous d\'abord.' });
    if (!user.verified) return res.status(403).json({ error: 'Compte non vérifié.' });

    const s = await getSettings();
    const cfg = s.paiement.cinetpay;
    if (!cfg.enabled || !cfg.siteId || !cfg.apiKey) return res.status(400).json({ error: 'Mobile Money n\'est pas activé.' });

    const plans = await getEffectivePlans();
    const plan = plans[String(req.body?.plan || '')];
    if (!plan) return res.status(400).json({ error: 'Plan inconnu.' });
    const channel = String(req.body?.channel || 'MOBILE_MONEY').toUpperCase(); // MTN, OM, WAVE, MOBILE_MONEY (tous)

    const token = crypto.randomBytes(24).toString('hex');
    const now = Date.now();
    await db.execute({
      sql: `INSERT INTO sessions
            (token, user_id, plan, price, payer_name, payer_phone, transaction_ref, status, created_at, expires_at, gateway, external_ref)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 'cinetpay', ?)`,
      args: [token, user.id, plan.key, plan.price, user.email, '', null, now, now + plan.durationMs, token],
    });

    const origin = req.get('origin') || `${req.protocol}://${req.get('host')}`;
    const cpRes = await fetch('https://api-checkout.cinetpay.com/v2/payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apikey: cfg.apiKey,
        site_id: cfg.siteId,
        transaction_id: token,
        amount: plan.price,
        currency: s.entreprise.devise === 'FCFA' ? 'XOF' : s.entreprise.devise,
        description: plan.label,
        customer_email: user.email,
        channels: channel,
        notify_url: `${origin}/webhook/cinetpay`,
        return_url: `${origin}/?paiement=succes`,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await cpRes.json();
    if (!cpRes.ok || data.code !== '201') {
      console.error('[cinetpay init]', data);
      await db.execute({ sql: `UPDATE sessions SET status = 'rejected' WHERE token = ?`, args: [token] });
      return res.status(502).json({ error: data.message || 'Échec de l\'initialisation du paiement.' });
    }
    res.json({ url: data.data.payment_url });
  } catch (e) {
    console.error('[cinetpay]', e);
    res.status(500).json({ error: 'Erreur lors de la création du paiement.' });
  }
});

app.post('/webhook/cinetpay', async (req, res) => {
  try {
    const transactionId = String(req.body?.cpm_trans_id || req.body?.transaction_id || '');
    if (!transactionId) return res.status(400).send('Requête invalide.');

    const s = await getSettings();
    const cfg = s.paiement.cinetpay;
    if (!cfg.enabled || !cfg.siteId || !cfg.apiKey) return res.status(400).send('CinetPay désactivé.');

    // On ne fait jamais confiance à la notification seule : on revérifie auprès de CinetPay.
    const checkRes = await fetch('https://api-checkout.cinetpay.com/v2/payment/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apikey: cfg.apiKey, site_id: cfg.siteId, transaction_id: transactionId }),
      signal: AbortSignal.timeout(15000),
    });
    const check = await checkRes.json();
    const status = check && check.data && check.data.status;

    if (status === 'ACCEPTED') {
      const result = await decideSession(transactionId, 'activate');
      if (result.error) console.error('[webhook cinetpay] activation échouée :', result.error);
    } else if (status === 'REFUSED') {
      await decideSession(transactionId, 'reject');
    }
    res.status(200).send('ok');
  } catch (e) {
    console.error('[webhook cinetpay]', e);
    res.status(500).send('Erreur serveur.');
  }
});

/* ============================================================
   SIGNALEMENT
   ============================================================ */

const WA_TARGET_RE = /^(\+?[0-9 ()\-]{6,20}|https?:\/\/(wa\.me|chat\.whatsapp\.com|api\.whatsapp\.com)\/\S{1,150})$/i;

app.post('/api/report', limitReport, async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Non authentifié.' });

    const sess = await getActiveSession(user.id);
    if (!sess) return res.status(403).json({ error: 'Aucun accès actif. Veuillez payer.' });

    const category = String(req.body?.category || '');
    const severity = String(req.body?.severity || 'Modérée');
    const waNumber = cleanLine(req.body?.waNumber, 200);
    const caseId   = cleanLine(req.body?.caseId, 60);
    const message  = cleanText(req.body?.message, 5000);

    if (!category || !waNumber) return res.status(400).json({ error: 'Catégorie et numéro WhatsApp requis.' });
    if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'Catégorie invalide.' });
    if (!SEVERITIES.includes(severity)) return res.status(400).json({ error: 'Gravité invalide.' });
    if (!WA_TARGET_RE.test(waNumber)) return res.status(400).json({ error: 'Numéro ou lien WhatsApp invalide.' });

    const sentToday = await countRows(
      `SELECT COUNT(*) AS c FROM reports WHERE user_id = ? AND created_at > ?`,
      [user.id, Date.now() - 24 * 60 * 60 * 1000]);
    if (sentToday >= MAX_REPORTS_PER_DAY) {
      return res.status(429).json({ error: 'Limite quotidienne de signalements atteinte.' });
    }

    const requested = Array.isArray(req.body?.destinations) ? req.body.destinations : [];
    const dests = requested.length
      ? [...new Set(requested.filter((d) => WHATSAPP_EMAILS.includes(d)))]
      : WHATSAPP_EMAILS;
    if (!dests.length) return res.status(400).json({ error: 'Aucune adresse de destination valide.' });

    const results = await Promise.allSettled(
      dests.map((d) => sendWhatsAppReport({ caseId, category, severity, waNumber, message, destination: d }))
    );
    results.forEach((r, i) => {
      if (r.status === 'rejected') console.error('[report mail]', dests[i], r.reason && r.reason.message);
    });
    const ok = results.filter((r) => r.status === 'fulfilled').length;

    await db.execute({
      sql: `INSERT INTO reports (user_id, case_id, category, severity, wa_number, message, created_at, email_status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [user.id, caseId, category, severity, waNumber, message, Date.now(), `${ok}/${dests.length}`],
    });

    res.json({ sent: ok, total: dests.length });
  } catch (e) {
    console.error('[report]', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/* ============================================================
   ADMIN — Basic Auth (mot de passe jamais dans l'URL), sortie échappée,
   CSP avec nonce, validation des paiements
   ============================================================ */

function adminAuth(req, res, next) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) {
    const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    const pass = i >= 0 ? decoded.slice(i + 1) : '';
    if (safeEqual(sha256(pass), sha256(ADMIN_PASSWORD))) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Takamura Admin", charset="UTF-8"');
  res.status(401).send('Non autorisé.');
}

// Anti-CSRF : les navigateurs renvoient automatiquement le Basic Auth, donc les
// actions POST exigent un en-tête personnalisé (impossible en cross-site sans preflight).
function requireAdminXhr(req, res, next) {
  if (req.get('X-Requested-With') !== 'takamura-admin') return res.status(403).json({ error: 'Requête refusée.' });
  next();
}

const fmtDate = (ms) => (ms ? new Date(Number(ms)).toLocaleString('fr-FR', { timeZone: 'Africa/Douala' }) : '');

/* ============================================================
   DASHBOARD PRO — HTML (une seule page, servie inline depuis index.js)
   ============================================================ */
function DASHBOARD_HTML(nonce) {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Takamura — Dashboard PRO</title>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.4/chart.umd.min.js"></script>
<style nonce="${nonce}">
  :root{
    --bg:#09090B; --card:#18181B; --card-hover:#1f1f23; --border:#27272A;
    --violet:#7C3AED; --cyan:#06B6D4; --text:#F4F4F5; --text-dim:#A1A1AA; --text-dim2:#71717A;
    --green:#22C55E; --red:#EF4444; --amber:#F59E0B;
  }
  *{box-sizing:border-box}
  body{background:var(--bg);color:var(--text);font-family:'Inter',ui-sans-serif,system-ui,sans-serif;margin:0;overflow-x:hidden}
  ::-webkit-scrollbar{width:8px;height:8px} ::-webkit-scrollbar-thumb{background:#3f3f46;border-radius:8px}
  .card{background:var(--card);border:1px solid var(--border);border-radius:18px;transition:.25s}
  .glow:hover{border-color:rgba(124,58,237,.55);box-shadow:0 0 0 1px rgba(124,58,237,.25),0 12px 40px -12px rgba(124,58,237,.45);transform:translateY(-2px)}
  .grad-text{background:linear-gradient(90deg,var(--violet),var(--cyan));-webkit-background-clip:text;background-clip:text;color:transparent}
  .grad-bg{background:linear-gradient(135deg,var(--violet),var(--cyan))}
  .sidebar-link{display:flex;align-items:center;gap:12px;padding:11px 18px;border-radius:12px;color:var(--text-dim);cursor:pointer;border-left:3px solid transparent;transition:.2s;font-size:14px;font-weight:500}
  .sidebar-link:hover{background:#1c1c1f;color:var(--text)}
  .sidebar-link.active{background:linear-gradient(90deg,rgba(124,58,237,.18),rgba(6,182,212,.06));border-left:3px solid var(--violet);color:#fff}
  .view{animation:fadeIn .35s ease}
  @keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  .hidden{display:none!important}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;color:var(--text-dim2);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:10px 14px;border-bottom:1px solid var(--border)}
  td{padding:12px 14px;border-bottom:1px solid #1f1f23;color:var(--text-dim)}
  tr:hover td{background:#1c1c1f}
  .badge{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600}
  .badge-pending{background:rgba(245,158,11,.12);color:var(--amber)}
  .badge-active{background:rgba(34,197,94,.12);color:var(--green)}
  .badge-rejected{background:rgba(239,68,68,.12);color:var(--red)}
  .btn{padding:7px 14px;border-radius:10px;font-size:12.5px;font-weight:600;cursor:pointer;border:1px solid var(--border);background:#1c1c1f;color:var(--text);transition:.15s}
  .btn:hover{border-color:var(--violet)}
  .btn-primary{background:linear-gradient(135deg,var(--violet),var(--cyan));border:none;color:#fff}
  .btn-primary:hover{filter:brightness(1.1)}
  .btn-danger{border-color:rgba(239,68,68,.4);color:var(--red)}
  input[type=text],input[type=email],input[type=password],input[type=number],select,textarea{
    width:100%;background:#0f0f11;border:1px solid var(--border);border-radius:10px;padding:9px 12px;color:var(--text);font-size:13.5px;outline:none;transition:.15s}
  input:focus,select:focus,textarea:focus{border-color:var(--violet);box-shadow:0 0 0 3px rgba(124,58,237,.15)}
  label{font-size:12.5px;color:var(--text-dim);font-weight:500;display:block;margin-bottom:6px}
  .switch{position:relative;width:42px;height:24px;flex-shrink:0}
  .switch input{opacity:0;width:0;height:0}
  .slider{position:absolute;inset:0;background:#3f3f46;border-radius:999px;cursor:pointer;transition:.2s}
  .slider:before{content:'';position:absolute;height:18px;width:18px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s}
  .switch input:checked + .slider{background:linear-gradient(135deg,var(--violet),var(--cyan))}
  .switch input:checked + .slider:before{transform:translateX(18px)}
  .tab-btn{padding:9px 16px;border-radius:10px;font-size:13px;font-weight:600;color:var(--text-dim);cursor:pointer}
  .tab-btn.active{background:#1c1c1f;color:#fff;box-shadow:inset 0 0 0 1px var(--violet)}
  #toast{position:fixed;bottom:24px;right:24px;background:#18181B;border:1px solid var(--violet);border-radius:12px;padding:14px 20px;font-size:13.5px;box-shadow:0 12px 40px -10px rgba(0,0,0,.6);z-index:9999;transition:.3s;transform:translateY(20px);opacity:0}
  #toast.show{transform:none;opacity:1}
  .kpi-val{font-size:26px;font-weight:800;letter-spacing:-.02em}
  .chart-wrap{position:relative;height:280px}
  .avatar{width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;color:#fff}
</style>
</head>
<body>

<aside style="width:300px;position:fixed;top:0;left:0;height:100vh;background:#0c0c0e;border-right:1px solid var(--border);padding:22px 14px;display:flex;flex-direction:column;gap:4px;overflow-y:auto">
  <div style="display:flex;align-items:center;gap:10px;padding:8px 10px 22px">
    <div class="grad-bg" style="width:38px;height:38px;border-radius:11px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;color:#fff">T</div>
    <div>
      <div style="font-weight:800;font-size:15px">Takamura</div>
      <div style="font-size:11px;color:var(--text-dim2)">Dashboard PRO</div>
    </div>
  </div>
  <div class="sidebar-link active" data-view="dashboard">📊 <span>Dashboard</span></div>
  <div class="sidebar-link" data-view="orders">💳 <span>Commandes / Paiements</span></div>
  <div class="sidebar-link" data-view="clients">👥 <span>Clients</span></div>
  <div class="sidebar-link" data-view="products">📦 <span>Produits / Formations</span></div>
  <div class="sidebar-link" data-view="analytics">📈 <span>Analytics</span></div>
  <div class="sidebar-link" data-view="settings">⚙️ <span>Paramètres</span></div>
  <div style="margin-top:auto;padding:14px 10px 4px;border-top:1px solid var(--border);font-size:11px;color:var(--text-dim2)">
    Takamura Elite © ${new Date().getFullYear()}
  </div>
</aside>

<main style="margin-left:300px;padding:32px 36px;max-width:1500px">

  <section id="view-dashboard" class="view">
    <h1 style="font-size:24px;font-weight:800;margin:0 0 4px">Vue d'ensemble</h1>
    <p style="color:var(--text-dim2);font-size:13.5px;margin:0 0 24px">Revenus, commandes et activité en temps réel.</p>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:18px;margin-bottom:24px" id="kpiRow"></div>
    <div style="display:grid;grid-template-columns:2fr 1fr;gap:18px">
      <div class="card glow" style="padding:22px">
        <div style="font-weight:700;margin-bottom:14px">Revenus (accès activés)</div>
        <div class="chart-wrap"><canvas id="chartRevenue"></canvas></div>
      </div>
      <div class="card glow" style="padding:22px">
        <div style="font-weight:700;margin-bottom:14px">Commandes par statut</div>
        <div class="chart-wrap"><canvas id="chartStatus"></canvas></div>
      </div>
    </div>
  </section>

  <section id="view-orders" class="view hidden">
    <h1 style="font-size:24px;font-weight:800;margin:0 0 4px">Commandes &amp; Paiements</h1>
    <p style="color:var(--text-dim2);font-size:13.5px;margin:0 0 20px">Virement manuel + paiements automatiques Stripe / CinetPay.</p>
    <div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap">
      <select id="orderFilterStatus" style="width:180px">
        <option value="">Tous les statuts</option>
        <option value="pending">En attente</option>
        <option value="active">Payé</option>
        <option value="rejected">Échoué / rejeté</option>
      </select>
      <input type="text" id="orderSearch" placeholder="Rechercher email, nom, téléphone, référence…" style="max-width:320px">
      <button class="btn" id="orderRefresh">↻ Actualiser</button>
    </div>
    <div class="card" style="padding:0;overflow-x:auto">
      <table><thead><tr>
        <th>Date</th><th>Client</th><th>Produit</th><th>Prix</th><th>Moyen</th><th>Référence</th><th>Statut</th><th>Action</th>
      </tr></thead><tbody id="ordersBody"></tbody></table>
    </div>
  </section>

  <section id="view-clients" class="view hidden">
    <h1 style="font-size:24px;font-weight:800;margin:0 0 4px">Clients</h1>
    <p style="color:var(--text-dim2);font-size:13.5px;margin:0 0 20px">Comptes inscrits, dépenses et accès en cours.</p>
    <div style="display:grid;grid-template-columns:2fr 1fr;gap:18px">
      <div class="card" style="padding:0;overflow-x:auto">
        <div style="padding:16px"><input type="text" id="clientSearch" placeholder="Rechercher un email…" style="max-width:320px"></div>
        <table><thead><tr><th>Client</th><th>Inscrit le</th><th>Vérifié</th><th>Accès</th><th>Signalements</th><th>Total dépensé</th></tr></thead>
        <tbody id="clientsBody"></tbody></table>
      </div>
      <div class="card glow" style="padding:22px">
        <div style="font-weight:700;margin-bottom:14px">Répartition des accès</div>
        <div class="chart-wrap"><canvas id="chartClients"></canvas></div>
      </div>
    </div>
  </section>

  <section id="view-products" class="view hidden">
    <h1 style="font-size:24px;font-weight:800;margin:0 0 4px">Produits / Formations</h1>
    <p style="color:var(--text-dim2);font-size:13.5px;margin:0 0 20px">Les deux formules d'accès vendues sur le site public.</p>
    <div id="productsGrid" style="display:grid;grid-template-columns:repeat(2,1fr);gap:18px"></div>
  </section>

  <section id="view-analytics" class="view hidden">
    <h1 style="font-size:24px;font-weight:800;margin:0 0 4px">Analytics</h1>
    <p style="color:var(--text-dim2);font-size:13.5px;margin:0 0 20px">Vue détaillée sur 30 jours.</p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px">
      <div class="card glow" style="padding:22px"><div style="font-weight:700;margin-bottom:14px">Revenus / jour</div><div class="chart-wrap"><canvas id="an1"></canvas></div></div>
      <div class="card glow" style="padding:22px"><div style="font-weight:700;margin-bottom:14px">Commandes / jour</div><div class="chart-wrap"><canvas id="an2"></canvas></div></div>
      <div class="card glow" style="padding:22px"><div style="font-weight:700;margin-bottom:14px">Signalements / jour</div><div class="chart-wrap"><canvas id="an3"></canvas></div></div>
      <div class="card glow" style="padding:22px"><div style="font-weight:700;margin-bottom:14px">Signalements par catégorie</div><div class="chart-wrap"><canvas id="an4"></canvas></div></div>
    </div>
  </section>

  <section id="view-settings" class="view hidden">
    <h1 style="font-size:24px;font-weight:800;margin:0 0 4px">Paramètres</h1>
    <p style="color:var(--text-dim2);font-size:13.5px;margin:0 0 20px">Profil, entreprise, paiement, notifications, apparence, facturation.</p>
    <div style="display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap" id="settingsTabs">
      <div class="tab-btn active" data-tab="profil">Profil</div>
      <div class="tab-btn" data-tab="entreprise">Entreprise</div>
      <div class="tab-btn" data-tab="paiement">Paiement</div>
      <div class="tab-btn" data-tab="notifications">Notifications</div>
      <div class="tab-btn" data-tab="apparence">Apparence</div>
      <div class="tab-btn" data-tab="facturation">Facturation</div>
    </div>

    <div class="card glow" style="padding:26px;max-width:720px" id="settings-profil">
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px">
        <img id="profilPreview" src="" class="hidden" style="width:64px;height:64px;border-radius:16px;object-fit:cover">
        <div id="profilAvatarFallback" class="avatar grad-bg" style="width:64px;height:64px;border-radius:16px;font-size:22px">A</div>
        <div><input type="file" id="profilPhoto" accept="image/*"></div>
      </div>
      <div style="display:grid;gap:14px">
        <div><label>Nom</label><input type="text" id="profilNom"></div>
        <div><label>Email</label><input type="email" id="profilEmail"></div>
        <div><label>Nouveau mot de passe</label><input type="password" id="profilPassword" placeholder="Laisser vide pour ne pas changer"></div>
        <button class="btn btn-primary" data-save="profil" style="width:fit-content">Enregistrer</button>
      </div>
    </div>

    <div class="card glow hidden" style="padding:26px;max-width:720px" id="settings-entreprise">
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px">
        <img id="logoPreview" src="" class="hidden" style="width:64px;height:64px;border-radius:16px;object-fit:cover;background:#0f0f11">
        <div id="logoFallback" class="avatar grad-bg" style="width:64px;height:64px;border-radius:16px;font-size:22px">E</div>
        <div><input type="file" id="entLogo" accept="image/*"></div>
      </div>
      <div style="display:grid;gap:14px">
        <div><label>Nom de l'entreprise</label><input type="text" id="entNom"></div>
        <div><label>Adresse</label><input type="text" id="entAdresse"></div>
        <div><label>Devise</label>
          <select id="entDevise"><option value="FCFA">FCFA</option><option value="EUR">EUR</option><option value="USD">USD</option></select>
        </div>
        <button class="btn btn-primary" data-save="entreprise" style="width:fit-content">Enregistrer</button>
      </div>
    </div>

    <div class="card glow hidden" style="padding:26px;max-width:760px" id="settings-paiement">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;padding:14px;background:#0f0f11;border-radius:12px">
        <div><div style="font-weight:600">Mode</div><div style="font-size:12px;color:var(--text-dim2)">Test = simulation, Live = paiements réels</div></div>
        <select id="payMode" style="width:140px"><option value="test">Test</option><option value="live">Live</option></select>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div style="font-weight:700">Stripe (carte bancaire)</div>
        <label class="switch"><input type="checkbox" id="stripeEnabled"><span class="slider"></span></label>
      </div>
      <div style="display:grid;gap:12px;margin-bottom:24px">
        <div><label>Clé publique (pk_...)</label><input type="text" id="stripePublicKey"></div>
        <div><label>Clé secrète (sk_...)</label><input type="password" id="stripeSecretKey"></div>
        <div><label>Secret webhook (whsec_...)</label><input type="password" id="stripeWebhookSecret"></div>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div style="font-weight:700">CinetPay (Mobile Money)</div>
        <label class="switch"><input type="checkbox" id="cinetpayEnabled"><span class="slider"></span></label>
      </div>
      <div style="display:grid;gap:12px;margin-bottom:20px">
        <div><label>Site ID</label><input type="text" id="cinetpaySiteId"></div>
        <div><label>Clé API</label><input type="password" id="cinetpayApiKey"></div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px">
        <div class="card" style="padding:12px;display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:13px">MTN MoMo</span><label class="switch"><input type="checkbox" id="mtnEnabled"><span class="slider"></span></label>
        </div>
        <div class="card" style="padding:12px;display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:13px">Orange Money</span><label class="switch"><input type="checkbox" id="omEnabled"><span class="slider"></span></label>
        </div>
        <div class="card" style="padding:12px;display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:13px">Wave</span><label class="switch"><input type="checkbox" id="waveEnabled"><span class="slider"></span></label>
        </div>
      </div>
      <button class="btn btn-primary" data-save="paiement" style="width:fit-content">Enregistrer</button>
    </div>

    <div class="card glow hidden" style="padding:26px;max-width:560px" id="settings-notifications">
      <div style="display:grid;gap:16px">
        <div style="display:flex;align-items:center;justify-content:space-between"><span>Notifications par e-mail</span><label class="switch"><input type="checkbox" id="notifEmail"><span class="slider"></span></label></div>
        <div style="display:flex;align-items:center;justify-content:space-between"><span>Notifications par SMS</span><label class="switch"><input type="checkbox" id="notifSms"><span class="slider"></span></label></div>
        <div style="display:flex;align-items:center;justify-content:space-between"><span>Webhook sortant</span><label class="switch"><input type="checkbox" id="notifWebhook"><span class="slider"></span></label></div>
        <div><label>URL du webhook</label><input type="text" id="notifWebhookUrl" placeholder="https://..."></div>
        <button class="btn btn-primary" data-save="notifications" style="width:fit-content">Enregistrer</button>
      </div>
    </div>

    <div class="card glow hidden" style="padding:26px;max-width:560px" id="settings-apparence">
      <div style="display:grid;gap:16px">
        <div style="display:flex;align-items:center;justify-content:space-between"><span>Thème sombre</span><label class="switch"><input type="checkbox" id="apThemeDark" checked disabled><span class="slider"></span></label></div>
        <div><label>Couleur d'accent</label>
          <select id="apAccent"><option value="violet">Violet</option><option value="bleu">Bleu</option><option value="vert">Vert</option></select>
        </div>
        <div><label>Langue</label>
          <select id="apLangue"><option value="FR">Français</option><option value="EN">English</option></select>
        </div>
        <button class="btn btn-primary" data-save="apparence" style="width:fit-content">Enregistrer</button>
      </div>
    </div>

    <div class="card glow hidden" style="padding:26px;max-width:560px" id="settings-facturation">
      <div style="margin-bottom:18px">
        <div style="font-weight:700;margin-bottom:6px">Plan actuel : <span class="grad-text">Elite</span></div>
        <div style="font-size:12.5px;color:var(--text-dim2);margin-bottom:10px">Utilisation du mois — signalements envoyés</div>
        <div style="height:8px;background:#0f0f11;border-radius:999px;overflow:hidden">
          <div id="usageBar" class="grad-bg" style="height:100%;width:0%"></div>
        </div>
        <div id="usageLabel" style="font-size:11px;color:var(--text-dim2);margin-top:6px"></div>
      </div>
      <button class="btn btn-primary">Mettre à niveau</button>
    </div>
  </section>

</main>

<div id="toast"></div>

<script nonce="${nonce}">
(function(){
  "use strict";
  var CURRENCY = "FCFA";

  function toast(msg){
    var t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(function(){ t.classList.remove("show"); }, 2600);
  }

  function api(url, opts){
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {});
    if (opts.method && opts.method !== "GET") headers["X-Requested-With"] = "takamura-admin";
    if (opts.body && typeof opts.body !== "string") { headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(opts.body); }
    return fetch(url, Object.assign({}, opts, { headers: headers })).then(function(r){
      return r.json().then(function(data){
        if (!r.ok) throw new Error(data.error || "Erreur serveur");
        return data;
      });
    });
  }

  function fmtMoney(n){ return Number(n || 0).toLocaleString("fr-FR") + " " + CURRENCY; }

  /* ---------- Navigation ---------- */
  var views = ["dashboard","orders","clients","products","analytics","settings"];
  document.querySelectorAll(".sidebar-link").forEach(function(el){
    el.addEventListener("click", function(){
      document.querySelectorAll(".sidebar-link").forEach(function(x){ x.classList.remove("active"); });
      el.classList.add("active");
      var v = el.getAttribute("data-view");
      views.forEach(function(name){
        document.getElementById("view-" + name).classList.toggle("hidden", name !== v);
      });
      if (v === "dashboard") loadOverview();
      if (v === "orders") loadOrders();
      if (v === "clients") loadClients();
      if (v === "products") loadProducts();
      if (v === "analytics") loadAnalytics();
      if (v === "settings") loadSettings();
    });
  });

  /* ---------- Dashboard ---------- */
  var chartRevenue, chartStatus;
  function loadOverview(){
    api("/dashboard/api/overview").then(function(d){
      CURRENCY = d.currency || "FCFA";
      var kpis = [
        { label: "Revenu total", val: fmtMoney(d.totalRevenue) },
        { label: "Commandes", val: d.totalOrders },
        { label: "Clients", val: d.totalClients },
        { label: "Signalements", val: d.totalReports },
      ];
      document.getElementById("kpiRow").innerHTML = kpis.map(function(k){
        return '<div class="card glow" style="padding:20px"><div style="font-size:12px;color:var(--text-dim2);margin-bottom:8px">' + k.label + '</div><div class="kpi-val grad-text">' + k.val + '</div></div>';
      }).join("");

      var ctx1 = document.getElementById("chartRevenue").getContext("2d");
      var grad = ctx1.createLinearGradient(0,0,0,260);
      grad.addColorStop(0, "rgba(124,58,237,.45)"); grad.addColorStop(1, "rgba(6,182,212,.02)");
      if (chartRevenue) chartRevenue.destroy();
      chartRevenue = new Chart(ctx1, {
        type: "line",
        data: { labels: d.revenueSeries.map(function(x){return x.date;}), datasets: [{
          data: d.revenueSeries.map(function(x){return x.total;}), borderColor: "#7C3AED", backgroundColor: grad, fill: true, tension: .35, pointRadius: 0, borderWidth: 2.5,
        }]},
        options: { plugins: { legend: { display:false } }, scales: { x: { grid:{color:"#1f1f23"}, ticks:{color:"#71717A"} }, y: { grid:{color:"#1f1f23"}, ticks:{color:"#71717A"} } } }
      });

      var ctx2 = document.getElementById("chartStatus").getContext("2d");
      if (chartStatus) chartStatus.destroy();
      var s = d.ordersByStatus || {};
      chartStatus = new Chart(ctx2, {
        type: "doughnut",
        data: { labels: ["Payé","En attente","Rejeté"], datasets: [{ data: [s.active||0, s.pending||0, s.rejected||0], backgroundColor: ["#22C55E","#F59E0B","#EF4444"], borderWidth:0 }] },
        options: { plugins: { legend: { position:"bottom", labels:{ color:"#A1A1AA" } } }, cutout: "70%" }
      });
    }).catch(function(e){ toast(e.message); });
  }

  /* ---------- Commandes ---------- */
  function badge(status){
    var map = { pending: ["badge-pending","En attente"], active: ["badge-active","Payé"], rejected: ["badge-rejected","Rejeté"] };
    var m = map[status] || ["badge-pending", status];
    return '<span class="badge ' + m[0] + '">' + m[1] + '</span>';
  }
  function loadOrders(){
    var status = document.getElementById("orderFilterStatus").value;
    var search = document.getElementById("orderSearch").value;
    var qs = new URLSearchParams({ status: status, search: search }).toString();
    api("/dashboard/api/orders?" + qs).then(function(d){
      document.getElementById("ordersBody").innerHTML = d.orders.map(function(o){
        var actions = o.status === "pending"
          ? '<button class="btn" data-act="activate" data-token="' + o.token + '">Valider</button> <button class="btn btn-danger" data-act="reject" data-token="' + o.token + '">Rejeter</button>'
          : "—";
        return "<tr><td>" + new Date(o.created_at).toLocaleString("fr-FR") + "</td><td>" + (o.email||"—") + "</td><td>" + o.plan + "</td><td>" + fmtMoney(o.price) + "</td><td>" + o.gateway + "</td><td>" + (o.transaction_ref||"—") + "</td><td>" + badge(o.status) + "</td><td>" + actions + "</td></tr>";
      }).join("") || '<tr><td colspan="8" style="text-align:center;padding:30px;color:var(--text-dim2)">Aucune commande.</td></tr>';
    }).catch(function(e){ toast(e.message); });
  }
  document.getElementById("orderRefresh").addEventListener("click", loadOrders);
  document.getElementById("orderFilterStatus").addEventListener("change", loadOrders);
  var searchTimer;
  document.getElementById("orderSearch").addEventListener("input", function(){ clearTimeout(searchTimer); searchTimer = setTimeout(loadOrders, 300); });
  document.getElementById("ordersBody").addEventListener("click", function(e){
    var b = e.target.closest("button[data-act]");
    if (!b) return;
    if (b.dataset.act === "reject" && !confirm("Rejeter cette commande ?")) return;
    b.disabled = true;
    api("/dashboard/api/orders/decision", { method:"POST", body:{ token: b.dataset.token, action: b.dataset.act } })
      .then(function(){ toast("Commande mise à jour."); loadOrders(); loadOverview(); })
      .catch(function(err){ toast(err.message); b.disabled = false; });
  });

  /* ---------- Clients ---------- */
  var chartClients;
  function loadClients(){
    var search = document.getElementById("clientSearch").value;
    api("/dashboard/api/clients?" + new URLSearchParams({ search: search }).toString()).then(function(d){
      document.getElementById("clientsBody").innerHTML = d.clients.map(function(c){
        return "<tr><td>" + c.email + "</td><td>" + new Date(c.created_at).toLocaleDateString("fr-FR") + "</td><td>" + (c.verified ? "✅" : "❌") + "</td><td>" + (c.access_status ? badge("active") : badge("rejected")) + "</td><td>" + c.reports_count + "</td><td>" + fmtMoney(c.total_spent) + "</td></tr>";
      }).join("") || '<tr><td colspan="6" style="text-align:center;padding:30px;color:var(--text-dim2)">Aucun client.</td></tr>';

      var withAccess = d.clients.filter(function(c){ return c.access_status; }).length;
      var ctx = document.getElementById("chartClients").getContext("2d");
      if (chartClients) chartClients.destroy();
      chartClients = new Chart(ctx, {
        type: "doughnut",
        data: { labels: ["Accès actif","Sans accès"], datasets: [{ data: [withAccess, d.clients.length - withAccess], backgroundColor: ["#06B6D4","#3f3f46"], borderWidth:0 }] },
        options: { plugins: { legend: { position:"bottom", labels:{ color:"#A1A1AA" } } }, cutout: "70%" }
      });
    }).catch(function(e){ toast(e.message); });
  }
  var clientTimer;
  document.getElementById("clientSearch").addEventListener("input", function(){ clearTimeout(clientTimer); clientTimer = setTimeout(loadClients, 300); });

  /* ---------- Produits ---------- */
  function loadProducts(){
    api("/dashboard/api/products").then(function(d){
      document.getElementById("productsGrid").innerHTML = d.products.map(function(p){
        return '<div class="card glow" style="padding:22px">' +
          '<div style="font-weight:700;margin-bottom:14px">' + p.key + '</div>' +
          '<div style="display:grid;gap:12px">' +
          '<div><label>Nom</label><input type="text" data-field="label" data-key="' + p.key + '" value="' + p.label + '"></div>' +
          '<div><label>Prix (' + CURRENCY + ')</label><input type="number" data-field="price" data-key="' + p.key + '" value="' + p.price + '"></div>' +
          '<button class="btn btn-primary" data-save-product="' + p.key + '" style="width:fit-content">Enregistrer</button>' +
          '</div></div>';
      }).join("");
      document.querySelectorAll("[data-save-product]").forEach(function(btn){
        btn.addEventListener("click", function(){
          var key = btn.getAttribute("data-save-product");
          var label = document.querySelector('[data-field="label"][data-key="' + key + '"]').value;
          var price = document.querySelector('[data-field="price"][data-key="' + key + '"]').value;
          api("/dashboard/api/products", { method:"POST", body:{ key:key, label:label, price:price } })
            .then(function(){ toast("Produit mis à jour."); })
            .catch(function(e){ toast(e.message); });
        });
      });
    }).catch(function(e){ toast(e.message); });
  }

  /* ---------- Analytics ---------- */
  var anCharts = [];
  function lineChart(id, labels, data, color){
    var ctx = document.getElementById(id).getContext("2d");
    return new Chart(ctx, { type:"line", data:{ labels:labels, datasets:[{ data:data, borderColor:color, backgroundColor:"transparent", tension:.35, pointRadius:0, borderWidth:2.5 }]},
      options:{ plugins:{legend:{display:false}}, scales:{ x:{grid:{color:"#1f1f23"},ticks:{color:"#71717A"}}, y:{grid:{color:"#1f1f23"},ticks:{color:"#71717A"}} } } });
  }
  function barChart(id, labels, data, color){
    var ctx = document.getElementById(id).getContext("2d");
    return new Chart(ctx, { type:"bar", data:{ labels:labels, datasets:[{ data:data, backgroundColor:color, borderRadius:6 }]},
      options:{ plugins:{legend:{display:false}}, scales:{ x:{grid:{display:false},ticks:{color:"#71717A"}}, y:{grid:{color:"#1f1f23"},ticks:{color:"#71717A"}} } } });
  }
  function loadAnalytics(){
    anCharts.forEach(function(c){ c.destroy(); }); anCharts = [];
    api("/dashboard/api/analytics").then(function(d){
      anCharts.push(lineChart("an1", d.revenueByDay.map(function(x){return x.date;}), d.revenueByDay.map(function(x){return x.value;}), "#7C3AED"));
      anCharts.push(barChart("an2", d.ordersByDay.map(function(x){return x.date;}), d.ordersByDay.map(function(x){return x.value;}), "#06B6D4"));
      anCharts.push(lineChart("an3", d.reportsByDay.map(function(x){return x.date;}), d.reportsByDay.map(function(x){return x.value;}), "#F59E0B"));
      var ctx4 = document.getElementById("an4").getContext("2d");
      anCharts.push(new Chart(ctx4, { type:"doughnut", data:{ labels: d.reportsByCategory.map(function(x){return x.category;}), datasets:[{ data: d.reportsByCategory.map(function(x){return x.count;}), backgroundColor:["#7C3AED","#06B6D4","#F59E0B","#22C55E","#EF4444"], borderWidth:0 }]}, options:{ plugins:{legend:{position:"bottom",labels:{color:"#A1A1AA"}}}, cutout:"65%" } }));
    }).catch(function(e){ toast(e.message); });
  }

  /* ---------- Paramètres ---------- */
  var currentSettings = null;
  document.getElementById("settingsTabs").addEventListener("click", function(e){
    var t = e.target.closest(".tab-btn"); if (!t) return;
    document.querySelectorAll("#settingsTabs .tab-btn").forEach(function(x){ x.classList.remove("active"); });
    t.classList.add("active");
    ["profil","entreprise","paiement","notifications","apparence","facturation"].forEach(function(name){
      document.getElementById("settings-" + name).classList.toggle("hidden", name !== t.getAttribute("data-tab"));
    });
  });

  function fillSettingsForm(s){
    currentSettings = s;
    CURRENCY = s.entreprise.devise;
    document.getElementById("profilNom").value = s.profil.nom || "";
    document.getElementById("profilEmail").value = s.profil.email || "";
    document.getElementById("entNom").value = s.entreprise.nom || "";
    document.getElementById("entAdresse").value = s.entreprise.adresse || "";
    document.getElementById("entDevise").value = s.entreprise.devise || "FCFA";
    document.getElementById("payMode").value = s.paiement.mode || "test";
    document.getElementById("stripeEnabled").checked = !!s.paiement.stripe.enabled;
    document.getElementById("stripePublicKey").value = s.paiement.stripe.publicKey || "";
    document.getElementById("stripeSecretKey").value = s.paiement.stripe.secretKey || "";
    document.getElementById("stripeWebhookSecret").value = s.paiement.stripe.webhookSecret || "";
    document.getElementById("cinetpayEnabled").checked = !!s.paiement.cinetpay.enabled;
    document.getElementById("cinetpaySiteId").value = s.paiement.cinetpay.siteId || "";
    document.getElementById("cinetpayApiKey").value = s.paiement.cinetpay.apiKey || "";
    document.getElementById("mtnEnabled").checked = !!s.paiement.mtn_momo.enabled;
    document.getElementById("omEnabled").checked = !!s.paiement.orange_money.enabled;
    document.getElementById("waveEnabled").checked = !!s.paiement.wave.enabled;
    document.getElementById("notifEmail").checked = !!s.notifications.email;
    document.getElementById("notifSms").checked = !!s.notifications.sms;
    document.getElementById("notifWebhook").checked = !!s.notifications.webhook;
    document.getElementById("notifWebhookUrl").value = s.notifications.webhookUrl || "";
    document.getElementById("apAccent").value = s.apparence.accent || "violet";
    document.getElementById("apLangue").value = s.apparence.langue || "FR";
  }

  function loadSettings(){
    api("/dashboard/api/settings").then(function(d){ fillSettingsForm(d.settings); }).catch(function(e){ toast(e.message); });
    api("/dashboard/api/overview").then(function(d){
      var used = d.totalReports || 0, cap = 600;
      document.getElementById("usageBar").style.width = Math.min(100, (used/cap)*100) + "%";
      document.getElementById("usageLabel").textContent = used + " / " + cap + " signalements ce mois";
    }).catch(function(){});
  }

  function collectPatch(section){
    if (section === "profil") return { profil: { nom: document.getElementById("profilNom").value, email: document.getElementById("profilEmail").value } };
    if (section === "entreprise") return { entreprise: { nom: document.getElementById("entNom").value, adresse: document.getElementById("entAdresse").value, devise: document.getElementById("entDevise").value } };
    if (section === "paiement") return { paiement: {
      mode: document.getElementById("payMode").value,
      stripe: { enabled: document.getElementById("stripeEnabled").checked, publicKey: document.getElementById("stripePublicKey").value, secretKey: document.getElementById("stripeSecretKey").value, webhookSecret: document.getElementById("stripeWebhookSecret").value },
      cinetpay: { enabled: document.getElementById("cinetpayEnabled").checked, siteId: document.getElementById("cinetpaySiteId").value, apiKey: document.getElementById("cinetpayApiKey").value },
      mtn_momo: { enabled: document.getElementById("mtnEnabled").checked },
      orange_money: { enabled: document.getElementById("omEnabled").checked },
      wave: { enabled: document.getElementById("waveEnabled").checked },
    }};
    if (section === "notifications") return { notifications: { email: document.getElementById("notifEmail").checked, sms: document.getElementById("notifSms").checked, webhook: document.getElementById("notifWebhook").checked, webhookUrl: document.getElementById("notifWebhookUrl").value } };
    if (section === "apparence") return { apparence: { accent: document.getElementById("apAccent").value, langue: document.getElementById("apLangue").value, theme: "dark" } };
    return {};
  }
  document.querySelectorAll("[data-save]").forEach(function(btn){
    btn.addEventListener("click", function(){
      var section = btn.getAttribute("data-save");
      api("/dashboard/api/settings", { method:"POST", body: collectPatch(section) })
        .then(function(d){ fillSettingsForm(d.settings); toast("Paramètre enregistré."); })
        .catch(function(e){ toast(e.message); });
    });
  });

  ["profilPhoto","entLogo"].forEach(function(id){
    document.getElementById(id).addEventListener("change", function(e){
      var f = e.target.files[0]; if (!f) return;
      var reader = new FileReader();
      var isProfil = id === "profilPhoto";
      reader.onload = function(){
        var img = document.getElementById(isProfil ? "profilPreview" : "logoPreview");
        var fallback = document.getElementById(isProfil ? "profilAvatarFallback" : "logoFallback");
        img.src = reader.result; img.classList.remove("hidden"); fallback.classList.add("hidden");
      };
      reader.readAsDataURL(f);
    });
  });

  loadOverview();
})();
</script>
</body>
</html>`;
}

app.get('/admin', limitAdmin, adminAuth, async (_req, res) => {
  try {
    const [u, s, r] = await Promise.all([
      db.execute(`SELECT id, email, verified, created_at FROM users ORDER BY created_at DESC LIMIT 200`),
      db.execute(`SELECT token, user_id, plan, price, payer_name, payer_phone, transaction_ref, status, created_at, expires_at
                  FROM sessions
                  ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT 200`),
      db.execute(`SELECT id, user_id, case_id, category, severity, wa_number, message, created_at, email_status
                  FROM reports ORDER BY created_at DESC LIMIT 200`),
    ]);

    const nonce = crypto.randomBytes(16).toString('base64');
    res.set({
      'Content-Security-Policy':
        `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; ` +
        `base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      'Cache-Control': 'no-store',
    });

    const pendingCount = s.rows.filter((x) => x.status === 'pending').length;

    const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Takamura Admin</title>
<style>body{background:#0b0d10;color:#EDE8DC;font-family:monospace;padding:24px}
h2{color:#C8A54B;font-family:Georgia,serif}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;margin-bottom:30px;font-size:12px}
td,th{border:1px solid #333;padding:6px;text-align:left;vertical-align:top}
th{background:#15181e;color:#C8A54B}
tr.pending td{background:rgba(200,165,75,.10)}
button{font-family:inherit;font-size:11px;padding:5px 9px;cursor:pointer;border:1px solid #C8A54B;background:transparent;color:#F1D98F;margin-right:4px}
button.no{border-color:#B3121B;color:#E86A70}
button:disabled{opacity:.5;cursor:wait}</style>
<h2>Paiements à valider (${pendingCount})</h2>
<div class="scroll"><table><tr><th>Créé</th><th>Utilisateur</th><th>Plan</th><th>Prix</th><th>Nom</th><th>Tél</th><th>Réf</th><th>Statut</th><th>Expire</th><th>Action</th></tr>
${s.rows.map((x) => `<tr class="${x.status === 'pending' ? 'pending' : ''}"><td>${esc(fmtDate(x.created_at))}</td><td>${esc(x.user_id)}</td><td>${esc(x.plan)}</td><td>${esc(x.price)}</td><td>${esc(x.payer_name)}</td><td>${esc(x.payer_phone)}</td><td>${esc(x.transaction_ref)}</td><td>${esc(x.status)}</td><td>${esc(fmtDate(x.expires_at))}</td><td>${
      x.status === 'pending'
        ? `<button data-action="activate" data-token="${esc(x.token)}">Valider</button><button class="no" data-action="reject" data-token="${esc(x.token)}">Rejeter</button>`
        : ''
    }</td></tr>`).join('')}
</table></div>
<h2>Utilisateurs (${u.rows.length})</h2>
<div class="scroll"><table><tr><th>ID</th><th>Email</th><th>Vérifié</th><th>Créé</th></tr>
${u.rows.map((x) => `<tr><td>${esc(x.id)}</td><td>${esc(x.email)}</td><td>${x.verified ? '✅' : '❌'}</td><td>${esc(fmtDate(x.created_at))}</td></tr>`).join('')}
</table></div>
<h2>Signalements (${r.rows.length})</h2>
<div class="scroll"><table><tr><th>Date</th><th>User</th><th>Dossier</th><th>Catégorie</th><th>Gravité</th><th>Cible</th><th>Message</th><th>Emails</th></tr>
${r.rows.map((x) => `<tr><td>${esc(fmtDate(x.created_at))}</td><td>${esc(x.user_id)}</td><td>${esc(x.case_id)}</td><td>${esc(x.category)}</td><td>${esc(x.severity)}</td><td>${esc(x.wa_number)}</td><td>${esc(String(x.message || '').slice(0, 200))}</td><td>${esc(x.email_status)}</td></tr>`).join('')}
</table></div>
<script nonce="${nonce}">
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-action]');
  if (!b) return;
  if (b.dataset.action === 'reject' && !confirm('Rejeter ce paiement ?')) return;
  b.disabled = true;
  try {
    const res = await fetch('/admin/sessions/decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'takamura-admin' },
      body: JSON.stringify({ token: b.dataset.token, action: b.dataset.action }),
    });
    if (res.ok) return location.reload();
    const data = await res.json().catch(() => ({}));
    alert(data.error || 'Erreur');
  } catch { alert('Erreur réseau'); }
  b.disabled = false;
});
</script>`;
    res.type('html').send(html);
  } catch (e) {
    console.error('[admin]', e);
    res.status(500).send('Erreur serveur.');
  }
});

app.post('/admin/sessions/decision', limitAdmin, adminAuth, requireAdminXhr, async (req, res) => {
  try {
    const token = String(req.body?.token || '');
    const action = String(req.body?.action || '');
    if (!token || !['activate', 'reject'].includes(action)) return res.status(400).json({ error: 'Requête invalide.' });

    const result = await decideSession(token, action);
    if (result.error) return res.status(result.code || 400).json({ error: result.error });
    res.json(result);
  } catch (e) {
    console.error('[admin decision]', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/* ============================================================
   DASHBOARD PRO — API (mêmes identifiants admin que /admin)
   ============================================================ */

function dayKey(ms) {
  return new Date(Number(ms)).toISOString().slice(0, 10);
}

app.get('/dashboard/api/overview', limitAdmin, adminAuth, async (_req, res) => {
  try {
    const plans = await getEffectivePlans();
    const [sessions, users, reports] = await Promise.all([
      db.execute(`SELECT plan, price, status, created_at FROM sessions ORDER BY created_at ASC`),
      countRows(`SELECT COUNT(*) AS c FROM users`, []),
      countRows(`SELECT COUNT(*) AS c FROM reports`, []),
    ]);

    const byDay = new Map();
    const byStatus = { pending: 0, active: 0, rejected: 0 };
    const byPlan = {};
    let totalRevenue = 0;

    for (const s of sessions.rows) {
      byStatus[s.status] = (byStatus[s.status] || 0) + 1;
      byPlan[s.plan] = (byPlan[s.plan] || 0) + 1;
      if (s.status === 'active') {
        totalRevenue += Number(s.price) || 0;
        const k = dayKey(s.created_at);
        byDay.set(k, (byDay.get(k) || 0) + Number(s.price));
      }
    }

    const revenueSeries = [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, total]) => ({ date, total }));
    const planBreakdown = Object.keys(byPlan).map((key) => ({
      key, label: (plans[key] && plans[key].label) || key, count: byPlan[key],
    }));

    res.json({
      totalRevenue,
      totalOrders: sessions.rows.length,
      totalClients: users,
      totalReports: reports,
      ordersByStatus: byStatus,
      revenueSeries,
      planBreakdown,
      currency: (await getSettings()).entreprise.devise,
    });
  } catch (e) {
    console.error('[dashboard overview]', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

app.get('/dashboard/api/analytics', limitAdmin, adminAuth, async (_req, res) => {
  try {
    const [sessions, reports] = await Promise.all([
      db.execute(`SELECT plan, price, status, created_at FROM sessions ORDER BY created_at ASC`),
      db.execute(`SELECT category, created_at FROM reports ORDER BY created_at ASC`),
    ]);

    const revenueByDay = new Map();
    const ordersByDay = new Map();
    for (const s of sessions.rows) {
      const k = dayKey(s.created_at);
      ordersByDay.set(k, (ordersByDay.get(k) || 0) + 1);
      if (s.status === 'active') revenueByDay.set(k, (revenueByDay.get(k) || 0) + Number(s.price));
    }
    const reportsByCategory = {};
    const reportsByDay = new Map();
    for (const r of reports.rows) {
      reportsByCategory[r.category] = (reportsByCategory[r.category] || 0) + 1;
      const k = dayKey(r.created_at);
      reportsByDay.set(k, (reportsByDay.get(k) || 0) + 1);
    }

    const toSeries = (m) => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, v]) => ({ date, value: v }));

    res.json({
      revenueByDay: toSeries(revenueByDay),
      ordersByDay: toSeries(ordersByDay),
      reportsByDay: toSeries(reportsByDay),
      reportsByCategory: Object.entries(reportsByCategory).map(([category, count]) => ({ category, count })),
    });
  } catch (e) {
    console.error('[dashboard analytics]', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

app.get('/dashboard/api/orders', limitAdmin, adminAuth, async (req, res) => {
  try {
    const status = String(req.query.status || '');
    const search = String(req.query.search || '').trim();
    const where = [];
    const args = [];
    if (status && ['pending', 'active', 'rejected'].includes(status)) { where.push('s.status = ?'); args.push(status); }
    if (search) {
      where.push('(u.email LIKE ? OR s.payer_name LIKE ? OR s.payer_phone LIKE ? OR s.transaction_ref LIKE ?)');
      args.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    const sql = `SELECT s.token, s.plan, s.price, s.payer_name, s.payer_phone, s.transaction_ref,
                        s.status, s.gateway, s.created_at, s.expires_at, u.email
                 FROM sessions s LEFT JOIN users u ON u.id = s.user_id
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY CASE s.status WHEN 'pending' THEN 0 ELSE 1 END, s.created_at DESC LIMIT 300`;
    const r = await db.execute({ sql, args });
    res.json({ orders: r.rows });
  } catch (e) {
    console.error('[dashboard orders]', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

app.post('/dashboard/api/orders/decision', limitAdmin, adminAuth, requireAdminXhr, async (req, res) => {
  try {
    const token = String(req.body?.token || '');
    const action = String(req.body?.action || '');
    if (!token || !['activate', 'reject'].includes(action)) return res.status(400).json({ error: 'Requête invalide.' });
    const result = await decideSession(token, action);
    if (result.error) return res.status(result.code || 400).json({ error: result.error });
    res.json(result);
  } catch (e) {
    console.error('[dashboard orders decision]', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

app.get('/dashboard/api/clients', limitAdmin, adminAuth, async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const sql = `SELECT u.id, u.email, u.verified, u.created_at,
                        (SELECT COUNT(*) FROM reports r WHERE r.user_id = u.id) AS reports_count,
                        (SELECT COALESCE(SUM(price),0) FROM sessions s WHERE s.user_id = u.id AND s.status = 'active') AS total_spent,
                        (SELECT status FROM sessions s WHERE s.user_id = u.id AND s.status = 'active' AND s.expires_at > ? ORDER BY s.expires_at DESC LIMIT 1) AS access_status
                 FROM users u
                 ${search ? 'WHERE u.email LIKE ?' : ''}
                 ORDER BY u.created_at DESC LIMIT 300`;
    const args = [Date.now()];
    if (search) args.push(`%${search}%`);
    const r = await db.execute({ sql, args });
    res.json({ clients: r.rows });
  } catch (e) {
    console.error('[dashboard clients]', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

app.get('/dashboard/api/products', limitAdmin, adminAuth, async (_req, res) => {
  try {
    const plans = await getEffectivePlans();
    res.json({ products: Object.values(plans) });
  } catch (e) {
    console.error('[dashboard products]', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

app.post('/dashboard/api/products', limitAdmin, adminAuth, requireAdminXhr, async (req, res) => {
  try {
    const key = String(req.body?.key || '');
    if (!PLANS[key]) return res.status(400).json({ error: 'Produit inconnu.' });
    const label = cleanLine(req.body?.label, 80) || PLANS[key].label;
    const price = Number(req.body?.price);
    if (!(price > 0)) return res.status(400).json({ error: 'Prix invalide.' });
    const settings = await saveSettings({ produits: { [key]: { label, price } } });
    res.json({ ok: true, product: settings.produits[key] });
  } catch (e) {
    console.error('[dashboard products save]', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

app.get('/dashboard/api/settings', limitAdmin, adminAuth, async (_req, res) => {
  try { res.json({ settings: await getSettings() }); }
  catch (e) { console.error('[dashboard settings get]', e); res.status(500).json({ error: 'Erreur serveur.' }); }
});

app.post('/dashboard/api/settings', limitAdmin, adminAuth, requireAdminXhr, async (req, res) => {
  try {
    const patch = req.body && typeof req.body === 'object' ? req.body : {};
    const settings = await saveSettings(patch);
    res.json({ ok: true, settings });
  } catch (e) {
    console.error('[dashboard settings save]', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

app.get('/dashboard', limitAdmin, adminAuth, (_req, res) => {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.set({
    'Content-Security-Policy':
      `default-src 'none'; style-src 'unsafe-inline' https://cdnjs.cloudflare.com; ` +
      `script-src 'nonce-${nonce}' https://cdnjs.cloudflare.com; img-src 'self' data:; ` +
      `font-src https://cdnjs.cloudflare.com; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'Cache-Control': 'no-store',
  });
  res.type('html').send(DASHBOARD_HTML(nonce));
});

/* ========================== ERREURS ========================== */
app.use('/api', (_req, res) => res.status(404).json({ error: 'Route inconnue.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Requête invalide.' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Requête trop volumineuse.' });
  console.error('[ERR]', err);
  res.status(500).json({ error: 'Erreur serveur.' });
});

/* ========================== DÉMARRAGE ========================== */
(async () => {
  await initDb();
  app.listen(PORT, () => console.log(`[HTTP] Takamura Elite sur le port ${PORT}`));
})().catch((e) => {
  console.error('[BOOT] Échec du démarrage :', e);
  process.exit(1);
});
