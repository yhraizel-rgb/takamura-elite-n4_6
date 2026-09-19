'use strict';

/* ============================================================================
   TAKAMURA ELITE — index.js
   Serveur unique : paiement (24h/1 semaine), sessions, signalements WhatsApp.
   Tout est hardcodé dans ce fichier.
   ============================================================================ */

const express    = require('express');
const nodemailer = require('nodemailer');
const crypto     = require('crypto');
const path       = require('path');
const { createClient } = require('@tursodatabase/serverless/compat');

const PORT = process.env.PORT || 3000;

/* ========================== CONFIG HARDCODÉE ========================== */

// --- Expéditeur Gmail (utilisé pour envoyer les signalements WhatsApp) ---
const EMAIL_USER = 'yenohyenoh209@gmail.com';
const EMAIL_PASS = 'nbcg xeen earl irta';
const ADMIN_EMAIL = 'yenohyenoh209@gmail.com';   // reçoit les notifs de paiement

// --- Codes / mots de passe ---
const ACCESS_CODE    = 'TAKAMURA2026';            // code d'accès manuel (bonus)
const ADMIN_PASSWORD = 'TAKAMURA-ADMIN-2026';     // /admin?pw=...

// --- Informations de paiement affichées à l'utilisateur ---
const PAYMENT_INFO = {
  orange_money: '+237 690 000 000',   // ← à modifier
  mtn_momo:     '+237 680 000 000',   // ← à modifier
  beneficiary:  'Takamura Elite',
  proof_email:  'yenohyenoh209@gmail.com',
};

// --- Plans payants ---
const PLANS = {
  day: {
    key: 'day',
    label: 'Accès 24 heures',
    price: 1000,
    durationMs: 24 * 60 * 60 * 1000,
    currency: 'FCFA',
  },
  week: {
    key: 'week',
    label: 'Accès 1 semaine',
    price: 2500,
    durationMs: 7 * 24 * 60 * 60 * 1000,
    currency: 'FCFA',
  },
};

// --- Toutes les adresses WhatsApp pour les signalements ---
const WHATSAPP_EMAILS = [
  'support@support.whatsapp.com',
  'support@whatsapp.com',
  'android@support.whatsapp.com',
  'smb@support.whatsapp.com',
  'accessibility@support.whatsapp.com',
];

/* ========================== TURSO DB ========================== */

const db = createClient({
  url: 'libsql://yh-yhrespon77.aws-us-east-1.turso.io',
  authToken: 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODk2MTQyNTgsImlkIjoiMDFhMGFkM2EtMDAwMS03NGE3LWFjMmMtZDIzZDQzNzQwZDJmIiwia2lkIjoicTIzMHlLZ1lJRlYtakt2czZPTmttNkpMdk1PTGt1TzFQcm5wamdka3c4VSIsInJpZCI6ImNhY2YzZWU1LTM3ZWMtNGY5My05N2ZkLTQwMGVhODIwOGFhYyJ9.XCpmnB8zB0r_F7YHoUoJIcOHVhCCKAzWo9F2vUY45eGorwJuaV4QI--1DqhF-eOzq3djWsfnW0dYv5OjmIwMAg',
});

async function initDb() {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        plan TEXT NOT NULL,
        price INTEGER NOT NULL,
        payer_name TEXT,
        payer_phone TEXT,
        transaction_ref TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id TEXT,
        category TEXT,
        severity TEXT,
        wa_number TEXT,
        message TEXT,
        created_at INTEGER NOT NULL,
        email_status TEXT
      )
    `);
    console.log('[DB] Tables prêtes.');
  } catch (err) {
    console.error('[DB] Erreur init:', err.message);
  }
}

/* ========================== MAILER ========================== */

const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: EMAIL_USER, pass: EMAIL_PASS },
});

async function sendWhatsAppReport({ caseId, category, severity, waNumber, message, destination }) {
  const subject = `Signalement WhatsApp — ${category} — ${waNumber}`;
  let body = `${caseId}\n`;
  body += `Catégorie : ${category}\n`;
  body += `Gravité : ${severity}\n`;
  body += `Numéro / lien WhatsApp signalé : ${waNumber}\n\n`;
  if (message) body += `Message litigieux (copié par le déclarant) :\n${message}\n\n`;
  body += `Merci d'examiner ce compte pour violation des conditions d'utilisation WhatsApp.\n`;

  return mailer.sendMail({
    from: `"Takamura Elite" <${EMAIL_USER}>`,
    to: destination,
    subject,
    text: body,
  });
}

async function sendAdminNotification(info) {
  try {
    await mailer.sendMail({
      from: `"Takamura Elite" <${EMAIL_USER}>`,
      to: ADMIN_EMAIL,
      subject: `[Takamura] Nouveau paiement — ${info.planLabel} (${info.price} FCFA)`,
      text:
        `Nouveau paiement enregistré.\n\n` +
        `Plan      : ${info.planLabel}\n` +
        `Prix      : ${info.price} ${info.currency}\n` +
        `Nom       : ${info.name}\n` +
        `Téléphone : ${info.phone}\n` +
        `Réf. tx   : ${info.transactionRef || '(non fourni)'}\n` +
        `Token     : ${info.token}\n` +
        `Expire le : ${new Date(info.expiresAt).toLocaleString('fr-FR')}\n`,
    });
  } catch (e) {
    console.error('[MAIL admin]', e.message);
  }
}

/* ========================== APP ========================== */

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));   // sert index.html à la racine

/* ---------- config publique ---------- */
app.get('/api/config', (_req, res) => {
  res.json({
    plans: Object.values(PLANS).map(p => ({
      key: p.key, label: p.label, price: p.price, currency: p.currency,
    })),
    payment: PAYMENT_INFO,
    whatsappEmails: WHATSAPP_EMAILS,
  });
});

/* ---------- création d'une session après paiement ---------- */
app.post('/api/payment/start', async (req, res) => {
  try {
    const { plan, name, phone, transactionRef } = req.body || {};
    const p = PLANS[plan];
    if (!p) return res.status(400).json({ error: 'Plan inconnu.' });
    if (!name || !phone) return res.status(400).json({ error: 'Nom et téléphone requis.' });

    const token = crypto.randomBytes(24).toString('hex');
    const now = Date.now();
    const expiresAt = now + p.durationMs;

    await db.execute({
      sql: `INSERT INTO sessions
            (token, plan, price, payer_name, payer_phone, transaction_ref, status, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      args: [token, p.key, p.price, name, phone, transactionRef || '', now, expiresAt],
    });

    // Notification admin (non bloquante)
    sendAdminNotification({
      planLabel: p.label, price: p.price, currency: p.currency,
      name, phone, transactionRef, token, expiresAt,
    }).catch(() => {});

    res.json({ token, expiresAt, plan: p.key });
  } catch (e) {
    console.error('[payment/start]', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/* ---------- vérification d'une session ---------- */
app.post('/api/session/check', async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token) return res.json({ valid: false });

    const r = await db.execute({
      sql: `SELECT token, plan, price, status, created_at, expires_at FROM sessions WHERE token = ?`,
      args: [token],
    });

    const row = r.rows && r.rows[0];
    if (!row) return res.json({ valid: false });
    if (row.status !== 'active') return res.json({ valid: false, reason: 'revoked' });
    if (Date.now() > Number(row.expires_at)) return res.json({ valid: false, reason: 'expired' });

    res.json({
      valid: true,
      plan: row.plan,
      expiresAt: Number(row.expires_at),
    });
  } catch (e) {
    console.error('[session/check]', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/* ---------- activation via code d'accès manuel ---------- */
app.post('/api/payment/code', async (req, res) => {
  try {
    const code = String((req.body && req.body.code) || '').trim().toUpperCase();
    if (code !== ACCESS_CODE) return res.status(401).json({ error: 'Code invalide.' });

    const token = crypto.randomBytes(24).toString('hex');
    const now = Date.now();
    const expiresAt = now + PLANS.day.durationMs;

    await db.execute({
      sql: `INSERT INTO sessions
            (token, plan, price, payer_name, payer_phone, transaction_ref, status, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      args: [token, 'code', 0, 'Code', '—', 'ACCESS_CODE', now, expiresAt],
    });

    res.json({ token, expiresAt, plan: 'code' });
  } catch (e) {
    console.error('[payment/code]', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/* ---------- envoi d'un signalement WhatsApp ---------- */
app.post('/api/report', async (req, res) => {
  try {
    const token = req.header('X-Session-Token') || '';
    const chk = await db.execute({
      sql: `SELECT status, expires_at FROM sessions WHERE token = ?`,
      args: [token],
    });
    const row = chk.rows && chk.rows[0];
    if (!row || row.status !== 'active' || Date.now() > Number(row.expires_at)) {
      return res.status(401).json({ error: 'Session invalide ou expirée.' });
    }

    const { caseId, category, severity, waNumber, message } = req.body || {};
    if (!category || !waNumber) {
      return res.status(400).json({ error: 'Catégorie et numéro WhatsApp requis.' });
    }

    const dests = (Array.isArray(req.body.destinations) && req.body.destinations.length)
      ? req.body.destinations.filter(d => WHATSAPP_EMAILS.includes(d))
      : WHATSAPP_EMAILS;

    const results = await Promise.allSettled(
      dests.map(d => sendWhatsAppReport({ caseId, category, severity, waNumber, message, destination: d }))
    );
    const ok = results.filter(r => r.status === 'fulfilled').length;

    await db.execute({
      sql: `INSERT INTO reports (case_id, category, severity, wa_number, message, created_at, email_status)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [caseId || '', category, severity || '', waNumber, message || '', Date.now(),
             `${ok}/${dests.length}`],
    });

    res.json({ sent: ok, total: dests.length });
  } catch (e) {
    console.error('[report]', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/* ---------- admin (lecture) ---------- */
app.get('/admin', async (req, res) => {
  if (req.query.pw !== ADMIN_PASSWORD) return res.status(401).send('Non autorisé.');
  try {
    const s = await db.execute(`SELECT * FROM sessions ORDER BY created_at DESC LIMIT 200`);
    const r = await db.execute(`SELECT * FROM reports ORDER BY created_at DESC LIMIT 200`);

    const html = `<!doctype html><meta charset="utf-8">
<title>Takamura Admin</title>
<style>body{background:#0b0d10;color:#EDE8DC;font-family:monospace;padding:24px}
h2{color:#C8A54B;font-family:Georgia,serif}
table{border-collapse:collapse;width:100%;margin-bottom:30px;font-size:12px}
td,th{border:1px solid #333;padding:6px;text-align:left;vertical-align:top}
th{background:#15181e;color:#C8A54B}</style>
<h2>Sessions (${s.rows.length})</h2>
<table><tr><th>Token</th><th>Plan</th><th>Nom</th><th>Tél</th><th>Réf</th><th>Statut</th><th>Créée</th><th>Expire</th></tr>
${s.rows.map(x => `<tr><td>${x.token.slice(0,10)}…</td><td>${x.plan}</td><td>${x.payer_name||''}</td><td>${x.payer_phone||''}</td><td>${x.transaction_ref||''}</td><td>${x.status}</td><td>${new Date(Number(x.created_at)).toLocaleString('fr-FR')}</td><td>${new Date(Number(x.expires_at)).toLocaleString('fr-FR')}</td></tr>`).join('')}
</table>
<h2>Signalements (${r.rows.length})</h2>
<table><tr><th>Dossier</th><th>Catégorie</th><th>Gravité</th><th>Numéro</th><th>Emails</th><th>Date</th></tr>
${r.rows.map(x => `<tr><td>${x.case_id}</td><td>${x.category}</td><td>${x.severity}</td><td>${x.wa_number}</td><td>${x.email_status}</td><td>${new Date(Number(x.created_at)).toLocaleString('fr-FR')}</td></tr>`).join('')}
</table>`;
    res.send(html);
  } catch (e) {
    console.error('[admin]', e);
    res.status(500).send('Erreur : ' + e.message);
  }
});

/* ---------- admin (révoquer une session) ---------- */
app.post('/api/admin/revoke', async (req, res) => {
  try {
    const { pw, token } = req.body || {};
    if (pw !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Non autorisé.' });
    if (!token) return res.status(400).json({ error: 'Token requis.' });
    await db.execute({
      sql: `UPDATE sessions SET status = 'revoked' WHERE token = ?`,
      args: [token],
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/* ---------- démarrage ---------- */
initDb().finally(() => {
  app.listen(PORT, () => console.log(`[Takamura Elite] http://localhost:${PORT}`));
});
