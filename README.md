# Mod Bot — Modération complète + Chat IA (Claude)

Bot Discord tout-en-un : modération manuelle, automod (anti-lien, anti-spam,
anti-mention, mots interdits, anti-raid), et chat IA multilingue via l'API
Anthropic (Claude).

## Installation (Termux / local)

1. `npm install`
2. Copie `.env.example` en `.env` et remplis :
   - `DISCORD_TOKEN`, `CLIENT_ID`, `OWNER_ID` (Developer Portal Discord)
   - `MONGODB_URI` (MongoDB Atlas — sans ça, tout est perdu au redémarrage)
   - `ANTHROPIC_API_KEY` (console.anthropic.com/settings/keys)
3. `node index.js`

## Inviter le bot sur un serveur

Sur le Developer Portal → ton appli → **OAuth2** → **URL Generator** :
- Scopes : `bot`, `applications.commands`
- Permissions : au minimum Kick, Ban, Moderate Members (timeout), Manage
  Messages, Manage Channels (verrouillage), Manage Roles, View/Send Messages.

## Qui peut modérer ?

Par défaut : les personnes avec **Administrateur** ou **Gérer le serveur**.
Ajoute d'autres rôles avec `/staffrole add`.

## Commandes

**Modération** : `/kick` `/ban` `/unban` `/timeout` `/untimeout` `/warn`
`/warnings` `/unwarn` `/clear` `/slowmode` `/lock` `/unlock` `/lockdown`
`/unlockdown`

**Historique** : `/case`, `/modlogs`

**Configuration** :
- `/setmodlog` : salon où sont postés tous les cas de modération
- `/staffrole add|remove|list`
- `/warnactions set|list|remove` : sanctions automatiques selon le nombre
  d'avertissements (par défaut : 3 → timeout 1h, 5 → timeout 24h, 7 → ban)
- `/automod antilien|antispam|antimention|motsinterdits|antiraid`

**IA (Claude)** :
- `/ai channel-add` : le bot répond à TOUS les messages de ce salon
- `/ai toggle` : répondre quand le bot est @mentionné n'importe où
- `/ai persona` : donner un ton/une personnalité au bot
- `/ai reset` : oublier la conversation en cours
- `/ask` : poser une question ponctuelle
- Le bot répond **toujours dans la langue de la personne**, quelle qu'elle
  soit (Claude gère ça nativement).

**Toi seul (OWNER_ID)** : `/diag` (état du stockage, doublons de bot, liste
des serveurs).

## Automod — valeurs par défaut

- Anti-lien (invitations Discord) : **désactivé** par défaut (active-le si besoin)
- Anti-spam : activé, 6 messages / 7s → timeout 10 min
- Anti-mention : activé, 5 mentions max par message → timeout 10 min
- Mots interdits : liste vide, désactivé
- Anti-raid : activé, 6 arrivées / 20s déclenche la vigilance ; les comptes
  de moins de 3 jours sont mis en sourdine 30 min pendant les 10 minutes qui
  suivent une vague suspecte

Tout est réglable avec `/automod`.

## Pourquoi le bot ne doit tourner qu'à UN seul endroit

Si tu le lances à la fois sur Termux et sur Render (ou deux services Render),
Discord répondra deux fois à chaque commande et tu auras des comportements
bizarres (actions en double, erreurs "déjà répondu"). `/diag` te dit si un
doublon est détecté. Arrête toujours l'autre copie (`pkill node` sur Termux)
avant de lancer l'autre.

## Anti-veille (plan gratuit Render)

Render éteint le service après ~15 min sans requête. Mets `PUBLIC_URL` (ton
URL Render) pour que le bot s'auto-ping toutes les 10 minutes.
