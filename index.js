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
const nodemailer = require('nodemailer');
const crypto     = require('crypto');
const path       = require('path');
const { promisify } = require('util');
const { createClient } = require('@tursodatabase/serverless/compat');

const scrypt = promisify(crypto.scrypt);

/* ========================== CONFIG (valeurs en dur) ========================== */
const PORT           = process.env.PORT || 3000;   // fourni automatiquement par la plupart des hébergeurs

const EMAIL_USER     = 'yenohyenoh209@gmail.com';
const EMAIL_PASS     = 'nbcg xeen earl irta';
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

async function initDb() {
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

/* ========================== MAILER ========================== */
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: EMAIL_USER, pass: EMAIL_PASS },
});
const FROM = `"Takamura Elite" <${EMAIL_USER}>`;

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
app.use(express.json({ limit: '100kb' }));
app.use('/api', limitGlobal);

// index.html est à la racine, à côté de index.js : on ne sert QUE ce fichier
// (pas express.static(__dirname), sinon index.js serait téléchargeable).
const INDEX_HTML = path.join(__dirname, 'index.html');
app.get(['/', '/index.html'], (_req, res) => res.sendFile(INDEX_HTML));

app.get('/api/config', (_req, res) => {
  res.json({
    plans: Object.values(PLANS).map((p) => ({ key: p.key, label: p.label, price: p.price, currency: p.currency })),
    payment: PAYMENT_INFO,
    whatsappEmails: WHATSAPP_EMAILS,
    codeTtlMinutes: Math.round(CODE_TTL_MS / 60000),
  });
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

    const r = await db.execute({
      sql: `SELECT s.token, s.plan, s.status, u.email
            FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
      args: [token],
    });
    const s = r.rows && r.rows[0];
    if (!s) return res.status(404).json({ error: 'Session introuvable.' });
    if (s.status !== 'pending') return res.status(409).json({ error: 'Cette demande a déjà été traitée.' });

    if (action === 'reject') {
      await db.execute({ sql: `UPDATE sessions SET status = 'rejected' WHERE token = ? AND status = 'pending'`, args: [token] });
      return res.json({ ok: true });
    }

    const plan = PLANS[s.plan];
    if (!plan) return res.status(400).json({ error: 'Plan inconnu.' });
    const now = Date.now();
    const expiresAt = now + plan.durationMs;
    await db.execute({
      sql: `UPDATE sessions SET status = 'active', created_at = ?, expires_at = ? WHERE token = ? AND status = 'pending'`,
      args: [now, expiresAt, token],
    });
    if (s.email) sendAccessActivatedEmail(s.email, plan.label, expiresAt).catch(() => {});
    res.json({ ok: true, expiresAt });
  } catch (e) {
    console.error('[admin decision]', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
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
