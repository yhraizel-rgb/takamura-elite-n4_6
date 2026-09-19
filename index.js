'use strict';

/* ============================================================================
   TAKAMURA ELITE — index.js
   Comptes + vérification email (code 6 chiffres) + paiement + signalements.
   ============================================================================ */

const express    = require('express');
const nodemailer = require('nodemailer');
const crypto     = require('crypto');
const { createClient } = require('@tursodatabase/serverless/compat');

const PORT = process.env.PORT || 3000;

/* ========================== CONFIG ========================== */
const EMAIL_USER = 'yenohyenoh209@gmail.com';
const EMAIL_PASS = 'nbcg xeen earl irta';
const ADMIN_EMAIL = 'yenohyenoh209@gmail.com';
const ADMIN_PASSWORD = 'TAKAMURA-ADMIN-2026';
const CODE_TTL_MS = 15 * 60 * 1000;   // code valable 15 min

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
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0,
      verification_code TEXT,
      verification_expires INTEGER,
      created_at INTEGER NOT NULL
    )`);
    // Compat si la table existait déjà sans ces colonnes :
    await ensureColumn('users', 'verified', 'INTEGER NOT NULL DEFAULT 0');
    await ensureColumn('users', 'verification_code', 'TEXT');
    await ensureColumn('users', 'verification_expires', 'INTEGER');

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
      status TEXT NOT NULL DEFAULT 'active',
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
    console.log('[DB] Tables prêtes.');
  } catch (err) {
    console.error('[DB] Erreur init:', err.message);
  }
}

/* ========================== AUTH HELPERS ========================== */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(password, stored) {
  try {
    const [algo, salt, hash] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const check = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
  } catch { return false; }
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 chiffres
}

async function getUserFromToken(req) {
  const token = req.header('X-User-Token') || '';
  if (!token) return null;
  const r = await db.execute({
    sql: `SELECT u.id, u.email, u.verified FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token = ?`,
    args: [token],
  });
  return (r.rows && r.rows[0]) || null;
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

async function issueToken(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  await db.execute({
    sql: `INSERT INTO auth_tokens (token, user_id, created_at) VALUES (?, ?, ?)`,
    args: [token, userId, Date.now()],
  });
  return token;
}

/* ========================== MAILER ========================== */
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: EMAIL_USER, pass: EMAIL_PASS },
});

async function sendVerificationEmail(email, code) {
  const subject = `Takamura Elite — Code de vérification : ${code}`;
  const text =
    `Bienvenue chez Takamura Elite.\n\n` +
    `Votre code de vérification est :\n\n` +
    `    ${code}\n\n` +
    `Ce code est valable ${Math.round(CODE_TTL_MS / 60000)} minutes.\n` +
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
        Valable ${Math.round(CODE_TTL_MS / 60000)} minutes. Si vous n'êtes pas à l'origine de cette inscription, ignorez cet email.
      </p>
    </div>`;
  return mailer.sendMail({ from: `"Takamura Elite" <${EMAIL_USER}>`, to: email, subject, text, html });
}

async function sendWhatsAppReport({ caseId, category, severity, waNumber, message, destination }) {
  const subject = `Signalement WhatsApp — ${category} — ${waNumber}`;
  let body = `${caseId}\n`;
  body += `Catégorie : ${category}\n`;
  body += `Gravité : ${severity}\n`;
  body += `Numéro / lien WhatsApp signalé : ${waNumber}\n\n`;
  if (message) body += `Message litigieux (copié par le déclarant) :\n${message}\n\n`;
  body += `Merci d'examiner ce compte pour violation des conditions d'utilisation WhatsApp.\n`;
  return mailer.sendMail({ from: `"Takamura Elite" <${EMAIL_USER}>`, to: destination, subject, text: body });
}

async function sendAdminNotification(info) {
  try {
    await mailer.sendMail({
      from: `"Takamura Elite" <${EMAIL_USER}>`,
      to: ADMIN_EMAIL,
      subject: `[Takamura] Nouveau paiement — ${info.planLabel} (${info.price} FCFA)`,
      text:
        `Nouveau paiement enregistré.\n\n` +
        `Compte    : ${info.email}\n` +
        `Plan      : ${info.planLabel}\n` +
        `Prix      : ${info.price} ${info.currency}\n` +
        `Nom       : ${info.name}\n` +
        `Téléphone : ${info.phone}\n` +
        `Réf. tx   : ${info.transactionRef || '(non fourni)'}\n` +
        `Expire le : ${new Date(info.expiresAt).toLocaleString('fr-FR')}\n`,
    });
  } catch (e) { console.error('[MAIL admin]', e.message); }
}

/* ========================== APP ========================== */
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

app.get('/api/config', (_req, res) => {
  res.json({
    plans: Object.values(PLANS).map(p => ({ key: p.key, label: p.label, price: p.price, currency: p.currency })),
    payment: PAYMENT_INFO,
    whatsappEmails: WHATSAPP_EMAILS,
    codeTtlMinutes: Math.round(CODE_TTL_MS / 60000),
  });
});

/* ============================================================
   AUTH : REGISTER (envoie le code) / VERIFY / RESEND / LOGIN / LOGOUT / ME
   ============================================================ */

app.post('/api/auth/register', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email invalide.' });
    if (password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (6 caractères min).' });

    const existing = await db.execute({ sql: `SELECT id, verified FROM users WHERE email = ?`, args: [email] });
    if (existing.rows.length) {
      const u = existing.rows[0];
      if (u.verified) return res.status(409).json({ error: 'Cet email est déjà utilisé.' });
      // Compte non vérifié → on régénère un code
      const code = generateCode();
      const expires = Date.now() + CODE_TTL_MS;
      await db.execute({
        sql: `UPDATE users SET password_hash = ?, verification_code = ?, verification_expires = ? WHERE id = ?`,
        args: [hashPassword(password), code, expires, u.id],
      });
      sendVerificationEmail(email, code).catch(e => console.error('[mail verify]', e.message));
      return res.json({ needsVerification: true, email });
    }

    const now = Date.now();
    const code = generateCode();
    const expires = now + CODE_TTL_MS;

    await db.execute({
      sql: `INSERT INTO users (email, password_hash, verified, verification_code, verification_expires, created_at)
            VALUES (?, ?, 0, ?, ?, ?)`,
      args: [email, hashPassword(password), code, expires, now],
    });

    sendVerificationEmail(email, code).catch(e => console.error('[mail verify]', e.message));
    res.json({ needsVerification: true, email });
  } catch (e) {
    console.error('[register]', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

app.post('/api/auth/verify', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const code = String(req.body?.code || '').trim();
    if (!email || !code) return res.status(400).json({ error: 'Email et code requis.' });

    const r = await db.execute({
      sql: `SELECT id, email, verified, verification_code, verification_expires FROM users WHERE email = ?`,
      args: [email],
    });
    const user = r.rows && r.rows[0];
    if (!user) return res.status(404).json({ error: 'Compte introuvable.' });
    if (user.verified) return res.status(400).json({ error: 'Ce compte est déjà vérifié.' });
    if (!user.verification_code || user.verification_code !== code) {
      return res.status(400).json({ error: 'Code incorrect.' });
    }
    if (!user.verification_expires || Date.now() > Number(user.verification_expires)) {
      return res.status(400).json({ error: 'Code expiré. Demandez un nouveau code.' });
    }

    await db.execute({
      sql: `UPDATE users SET verified = 1, verification_code = NULL, verification_expires = NULL WHERE id = ?`,
      args: [user.id],
    });

    const token = await issueToken(user.id);
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (e) {
    console.error('[verify]', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

app.post('/api/auth/resend', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email requis.' });

    const r = await db.execute({
      sql: `SELECT id, verified FROM users WHERE email = ?`,
      args: [email],
    });
    const user = r.rows && r.rows[0];
    if (!user) return res.status(404).json({ error: 'Compte introuvable.' });
    if (user.verified) return res.status(400).json({ error: 'Ce compte est déjà vérifié.' });

    const code = generateCode();
    const expires = Date.now() + CODE_TTL_MS;
    await db.execute({
      sql: `UPDATE users SET verification_code = ?, verification_expires = ? WHERE id = ?`,
      args: [code, expires, user.id],
    });

    sendVerificationEmail(email, code).catch(e => console.error('[mail resend]', e.message));
    res.json({ ok: true });
  } catch (e) {
    console.error('[resend]', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis.' });

    const r = await db.execute({
      sql: `SELECT id, email, password_hash, verified FROM users WHERE email = ?`,
      args: [email],
    });
    const user = r.rows && r.rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
    }
    if (!user.verified) {
      // Régénère un code si expiré/absent
      const code = generateCode();
      const expires = Date.now() + CODE_TTL_MS;
      await db.execute({
        sql: `UPDATE users SET verification_code = ?, verification_expires = ? WHERE id = ?`,
        args: [code, expires, user.id],
      });
      sendVerificationEmail(email, code).catch(e => console.error('[mail login-verify]', e.message));
      return res.status(403).json({ error: 'Compte non vérifié. Un nouveau code vous a été envoyé.', needsVerification: true, email });
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
    if (token) await db.execute({ sql: `DELETE FROM auth_tokens WHERE token = ?`, args: [token] });
    res.json({ ok: true });
  } catch { res.json({ ok: true }); }
});

app.get('/api/me', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Non authentifié.' });
    const sess = await getActiveSession(user.id);
    res.json({
      user: { id: user.id, email: user.email },
      hasAccess: !!sess,
      access: sess ? { plan: sess.plan, expiresAt: Number(sess.expires_at) } : null,
    });
  } catch (e) {
    console.error('[me]', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/* ============================================================
   PAIEMENT
   ============================================================ */

app.post('/api/payment/start', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Connectez-vous d\'abord.' });
    if (!user.verified) return res.status(403).json({ error: 'Compte non vérifié.' });

    const { plan, name, phone, transactionRef } = req.body || {};
    const p = PLANS[plan];
    if (!p) return res.status(400).json({ error: 'Plan inconnu.' });
    if (!name || !phone) return res.status(400).json({ error: 'Nom et téléphone requis.' });

    const token = crypto.randomBytes(24).toString('hex');
    const now = Date.now();
    const expiresAt = now + p.durationMs;

    await db.execute({
      sql: `INSERT INTO sessions
            (token, user_id, plan, price, payer_name, payer_phone, transaction_ref, status, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      args: [token, user.id, p.key, p.price, name, phone, transactionRef || '', now, expiresAt],
    });

    sendAdminNotification({
      email: user.email, planLabel: p.label, price: p.price, currency: p.currency,
      name, phone, transactionRef, expiresAt,
    }).catch(() => {});

    res.json({ plan: p.key, expiresAt });
  } catch (e) {
    console.error('[payment/start]', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/* ============================================================
   SIGNALEMENT
   ============================================================ */

app.post('/api/report', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Non authentifié.' });

    const sess = await getActiveSession(user.id);
    if (!sess) return res.status(403).json({ error: 'Aucun accès actif. Veuillez payer.' });

    const { caseId, category, severity, waNumber, message } = req.body || {};
    if (!category || !waNumber) return res.status(400).json({ error: 'Catégorie et numéro WhatsApp requis.' });

    const dests = (Array.isArray(req.body.destinations) && req.body.destinations.length)
      ? req.body.destinations.filter(d => WHATSAPP_EMAILS.includes(d))
      : WHATSAPP_EMAILS;

    const results = await Promise.allSettled(
      dests.map(d => sendWhatsAppReport({ caseId, category, severity, waNumber, message, destination: d }))
    );
    const ok = results.filter(r => r.status === 'fulfilled').length;

    await db.execute({
      sql: `INSERT INTO reports (user_id, case_id, category, severity, wa_number, message, created_at, email_status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [user.id, caseId || '', category, severity || '', waNumber, message || '', Date.now(), `${ok}/${dests.length}`],
    });

    res.json({ sent: ok, total: dests.length });
  } catch (e) {
    console.error('[report]', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/* ============================================================
   ADMIN
   ============================================================ */
app.get('/admin', async (req, res) => {
  if (req.query.pw !== ADMIN_PASSWORD) return res.status(401).send('Non autorisé.');
  try {
    const u = await db.execute(`SELECT id, email, verified, created_at FROM users ORDER BY created_at DESC LIMIT 200`);
    const s = await db.execute(`SELECT * FROM sessions ORDER BY created_at DESC LIMIT 200`);
    const r = await db.execute(`SELECT * FROM reports ORDER BY created_at DESC LIMIT 200`);

    const html = `<!doctype html><meta charset="utf-8"><title>Takamura Admin</title>
<style>body{background:#0b0d10;color:#EDE8DC;font-family:monospace;padding:24px}
h2{color:#C8A54B;font-family:Georgia,serif}
table{border-collapse:collapse;width:100%;margin-bottom:30px;font-size:12px}
td,th{border:1px solid #333;padding:6px;text-align:left;vertical-align:top}
th{background:#15181e;color:#C8A54B}</style>
<h2>Utilisateurs (${u.rows.length})</h2>
<table><tr><th>ID</th><th>Email</th><th>Vérifié</th><th>Créé</th></tr>
${u.rows.map(x => `<tr><td>${x.id}</td><td>${x.email}</td><td>${x.verified ? '✅' : '❌'}</td><td>${new Date(Number(x.created_at)).toLocaleString('fr-FR')}</td></tr>`).join('')}
</table>
<h2>Sessions (${s.rows.length})</h2>
<table><tr><th>User ID</th><th>Plan</th><th>Nom</th><th>Tél</th><th>Réf</th><th>Statut</th><th>Expire</th></tr>
${s.rows.map(x => `<tr><td>${x.user_id||''}</td><td>${x.plan}</td><td>${x.payer_name||''}</td><td>${x.payer_phone||''}</td><td>${x.transaction_ref||''}</td><td>${x.status}</t