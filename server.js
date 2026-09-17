require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db, initDb } = require('./db');
const { sendVerificationEmail } = require('./mailer');
const authMiddleware = require('./middleware/auth');

const path = require('path');

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Sert le front-end statique (public/index.html, /panel/assets, /images, ...)
app.use(express.static(path.join(__dirname, 'public')));

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// --- INSCRIPTION + envoi code email ---
app.post('/api/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis' });
  }

  const hashedPassword = bcrypt.hashSync(password, 10);
  const code = generateCode();

  try {
    await db.execute({
      sql: 'INSERT INTO users (email, password, verify_code) VALUES (?, ?, ?)',
      args: [email, hashedPassword, code],
    });

    await sendVerificationEmail(email, code);
    res.json({ message: 'Compte créé. Vérifie ton email pour le code.' });
  } catch (err) {
    res.status(400).json({ error: 'Cet email existe déjà ou erreur serveur' });
  }
});

// --- VÉRIFICATION DU CODE ---
app.post('/api/verify', async (req, res) => {
  const { email, code } = req.body;

  const result = await db.execute({
    sql: 'SELECT * FROM users WHERE email = ? AND verify_code = ?',
    args: [email, code],
  });

  if (result.rows.length === 0) {
    return res.status(400).json({ error: 'Code invalide' });
  }

  const user = result.rows[0];
  await db.execute({
    sql: 'UPDATE users SET verified = 1, verify_code = NULL WHERE id = ?',
    args: [user.id],
  });

  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET);
  res.json({ token, message: 'Email vérifié !' });
});

// --- CONNEXION ---
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  const result = await db.execute({
    sql: 'SELECT * FROM users WHERE email = ?',
    args: [email],
  });

  const user = result.rows[0];
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
  }

  if (!user.verified) {
    return res.status(403).json({ error: 'Email non vérifié' });
  }

  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET);
  res.json({ token });
});

// --- PROFIL ---
app.get('/api/me', authMiddleware, async (req, res) => {
  const result = await db.execute({
    sql: 'SELECT id, email, verified, created_at FROM users WHERE id = ?',
    args: [req.userId],
  });
  res.json(result.rows[0]);
});

// --- Alias attendu par le front-end (le JS téléchargé appelle "/api/auth/me") ---
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  const result = await db.execute({
    sql: 'SELECT id, email, verified, created_at FROM users WHERE id = ?',
    args: [req.userId],
  });
  res.json(result.rows[0] || null);
});

// --- Routes /api/v2/* attendues par le front-end ---
// Le front-end original appelait ces routes pour SA logique de vérification
// de comptes bannis. Ici, ce sont des stubs neutres à remplacer par TA propre
// logique métier (quoi que ton app doive réellement faire).

app.get('/api/v2/me', authMiddleware, async (req, res) => {
  const result = await db.execute({
    sql: 'SELECT id, email, verified, created_at FROM users WHERE id = ?',
    args: [req.userId],
  });
  res.json(result.rows[0] || null);
});

app.post('/api/v2/check', authMiddleware, async (req, res) => {
  // TODO : remplace ceci par la logique que TON app doit exécuter.
  res.json({
    input: req.body,
    result: 'not_implemented',
    message: 'Définis ici ta propre logique de vérification.',
  });
});

app.post('/api/v2/bulk-check', authMiddleware, async (req, res) => {
  // TODO : remplace ceci par ta propre logique (traitement en lot).
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  res.json({
    results: items.map((item) => ({ input: item, result: 'not_implemented' })),
  });
});

app.post('/api/v2/appeal-submit', authMiddleware, async (req, res) => {
  // TODO : remplace ceci par ta propre logique (ex : enregistrer en base,
  // envoyer un email, etc.)
  res.json({ message: 'Requête reçue.', data: req.body });
});

// Fallback SPA : toute route non-API renvoie index.html (nécessaire pour un routeur front comme React Router)
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => console.log(`Takamura Elite lancé sur http://localhost:${PORT}`));
});
