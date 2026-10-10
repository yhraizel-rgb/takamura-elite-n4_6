# Takamura Elite

Portail (front `index.html` + API Express `index.js`) : comptes vérifiés par e-mail, portefeuille
(recharge Money Fusion validée à la main par un admin), envoi de rapports aux supports WhatsApp par
e-mail, historique, base Turso, e-mails via Brevo.

## Fichiers

```
index.html     front (servi par index.js, jamais en statique)
index.js       serveur Express : comptes, portefeuille, rapports, e-mails, admin
yh.txt         motif automatique des rapports (utilisé quand le champ « Preuve » est vide)
package.json
```

## Lancer

```bash
npm install
npm start          # http://localhost:3000
```

Variable d'environnement : `BREVO_API_KEY` (e-mails). Le reste — y compris la clé de l'API de vérification de numéro — est en dur dans `index.js`.

## Envoi d'un rapport aux supports WhatsApp

Étape « Review & submit » :

- **Submit report** : le serveur envoie l'e-mail aux adresses de support choisies (depuis l'expéditeur Brevo).
  Un écran de type terminal affiche une **barre de progression en pourcentage** qui suit l'envoi réel :
  le serveur annonce chaque étape (`POST /api/report` avec `Accept: application/x-ndjson`, une ligne JSON par
  événement : `start`, `step` par adresse, `saving`, `done`). La barre ne montre 100 % qu'une fois l'envoi
  confirmé ; si la connexion tombe, elle reste bloquée en rouge et l'erreur s'affiche. Sans cet en-tête,
  la route répond en JSON comme avant.
- **Send from your own email app** : ouvre l'application mail de l'utilisateur (`mailto:`) avec tout pré-rempli.
  Aucun envoi côté serveur, donc pas de barre de progression.

## Motif automatique (yh.txt)

À l'étape « Preuve », le champ est **prérempli** avec le contenu de `yh.txt` (racine du projet), via `GET /api/motif?target=…`.
L'utilisateur peut le garder tel quel, le modifier ou y ajouter son texte ; ce qui est dans le champ est envoyé. Le fichier
se termine par `WhatsApp: https://api.whatsapp.com/send?phone={{NUMERO}}` : `{{NUMERO}}` est remplacé par le numéro cible
(chiffres seuls, ex. 237…). Pour une cible sans numéro (lien de groupe), le lien est remplacé par la cible telle quelle.
Le préremplissage suit la cible si l'utilisateur revient la changer, tant qu'il n'a rien modifié. Si le champ est envoyé
vide, le serveur applique le même motif (`defaultMotif`). `yh.txt` est relu à chaque appel : pas de redémarrage nécessaire.

## Vérification de numéro (API Baron0)

Page **Vérifier** du portail : l'utilisateur saisit un numéro, le serveur interroge `POST {BANCHECK_API_BASE}/api/v2/check`
(`Authorization: Bearer BANCHECK_API_KEY`) et affiche le statut : **NORMAL**, **BANNI**, **RESTREINT** (blocage de modération)
ou **INDÉTERMINÉ**, avec les détails fournis (type de ban, violation, catégorie, appel possible, UE, date du ban, appel déposé).
Tout autre champ simple renvoyé par ton plan Baron0 est affiché automatiquement dans le tableau de détails.

- `POST /api/checkban` : compte connecté + solde ≥ minimum (comme les signalements), sans limite de nombre
  de vérifications et sans déduction de solde. Résultat enregistré dans la table `checks`.
- `GET /api/checks` : 20 dernières vérifications du compte (cliquables pour réafficher le détail).
- La clé API (`BANCHECK_API_KEY`, en dur dans `index.js`) n'est jamais envoyée au navigateur : ne publie pas ce dépôt.

### Surveillance automatique des numéros ciblés

- **Après chaque envoi** : si la cible est un numéro (brut, `wa.me/…` ou `api.whatsapp.com/send?phone=…`), il est enregistré dans la
  table `watched_numbers` et vérifié aussitôt. Le résultat apparaît dans le terminal d'envoi et sur l'écran final
  (« Statut du numéro cible »). Les liens de groupe ne sont pas vérifiables. Si l'API ne répond pas, l'envoi n'est pas bloqué :
  la surveillance réessaie au cycle suivant.
- **Toutes les 15 minutes** (`WATCH_INTERVAL_MS`) : le serveur revérifie les numéros suivis, un par un (pause de 400 ms), tous les
  numéros suivis à chaque cycle, les plus anciennement vérifiés d'abord (un cycle encore en cours bloque le suivant). Un numéro est suivi **7 jours** après le dernier
  signalement (`WATCH_MAX_AGE_MS`) et le suivi s'arrête dès qu'il est **BANNI**. Si la clé est refusée (401/403) ou le quota atteint (429),
  le cycle s'interrompt et reprend 15 min plus tard.
- Un numéro signalé par plusieurs comptes n'est vérifié qu'une fois par cycle (un enregistrement par numéro).
- La colonne **Number status** de l'historique montre le dernier statut (survol : date de vérification, date du changement, type de ban).
- Le planificateur tourne dans le processus du serveur : il faut que l'hébergeur le laisse actif (pas de mise en veille).

## E-mails

Tous les e-mails passent par `sendViaBrevo` : 3 tentatives (erreur réseau, 429, 5xx), message d'erreur détaillé
dans les logs. Le code de vérification, la décision de recharge, l'avis admin et la réinitialisation de mot de
passe utilisent un même gabarit HTML (`emailLayout`) avec une version texte. Le contenu des e-mails de
signalement n'a pas changé.

## Sécurité

Le token Turso et le mot de passe admin sont en dur dans `index.js` : ne publie pas ce dépôt et régénère-les
s'ils ont été exposés.
