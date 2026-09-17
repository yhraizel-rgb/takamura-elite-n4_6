# Takamura Elite

Projet fusionné : front-end statique (`public/`) servi directement par le backend Express (`server.js`).

## Installation

```bash
npm install
```

## Configuration

Copie `.env.example` vers `.env` et remplis tes propres valeurs :

```bash
cp .env.example .env
```

⚠️ Ne commite jamais `.env` — il contient tes vrais secrets (token Turso, mot de passe email).
Si un secret a déjà été partagé ou exposé publiquement, régénère-le avant utilisation.

## Lancer le serveur

```bash
npm start
```

Le site est alors accessible sur `http://localhost:3000` — le front-end (`public/`) et l'API (`/api/...`) tournent ensemble sur le même port.

## Structure

```
takamura-elite/
├── public/              # front-end statique (HTML/CSS/JS)
│   ├── index.html
│   ├── images/
│   └── panel/assets/
├── server.js            # backend Express (sert public/ + API)
├── db.js                # connexion Turso
├── mailer.js            # envoi email de vérification
├── middleware/auth.js   # middleware JWT
└── .env                 # tes secrets (non versionné)
```

## Routes disponibles

- `POST /api/register` — créer un compte (envoie un code par email)
- `POST /api/verify` — vérifier l'email avec le code reçu
- `POST /api/login` — connexion (email vérifié requis)
- `GET /api/me` — profil (nécessite un token JWT dans le header Authorization: Bearer <token>)
