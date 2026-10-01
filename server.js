// ================================================================
// server.js — Serveur web du bot :
//  1) Endpoint de santé pour Render (démarre IMMÉDIATEMENT, avant Mongo/
//     Discord, sinon Render tue l'app pendant la connexion — voir index.js).
//  2) API du dashboard (/api/*), branchée sur le VRAI client Discord une
//     fois que le bot est connecté (voir setClient ci-dessous, appelé
//     depuis index.js dans le handler ClientReady).
//  3) Le dashboard lui-même (fichier statique) servi sur /panel.
//
// Rien ici n'est simulé : tant que setClient(client) n'a pas été appelé
// (bot pas encore prêt), l'API répond honnêtement "bot hors ligne" au lieu
// d'inventer des chiffres.
// ================================================================
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const app = express();
app.use(express.json());

// ----------------------------------------------------------------
// ÉTAT PARTAGÉ (rempli par index.js au fil de la vie du bot)
// ----------------------------------------------------------------
let client = null;           // le vrai Client discord.js, injecté après connexion
const startedAt = Date.now();
const MAX_LOGS = 300;
const recentLogs = [];       // anneau des derniers événements RÉELS (pushLog)
const aiStats = { exchanges: 0, blocked: 0, sinceRestart: startedAt };

function setClient(c) { client = c; }
// Appelé depuis index.js à chaque événement réel qui mérite d'apparaître
// dans "Logs" / "Dernières activités" du dashboard : type ∈ mod|ai|sys|msg.
function pushLog(type, text) {
  recentLogs.unshift({ time: Date.now(), type, text: String(text).slice(0, 300) });
  if (recentLogs.length > MAX_LOGS) recentLogs.length = MAX_LOGS;
}
function recordAiExchange({ blocked } = {}) {
  aiStats.exchanges += 1;
  if (blocked) aiStats.blocked += 1;
}

// ----------------------------------------------------------------
// AUTHENTIFICATION (code d'accès défini par toi, jamais en clair côté client)
// ----------------------------------------------------------------
const DASHBOARD_CODE = process.env.DASHBOARD_CODE || null;
const sessions = new Map(); // token -> expiresAt
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h, renouvelé à chaque requête
setInterval(() => { const now = Date.now(); for (const [t, exp] of sessions) if (exp < now) sessions.delete(t); }, 10 * 60 * 1000).unref();

function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const exp = sessions.get(token);
  if (!exp || exp < Date.now()) return res.status(401).json({ error: 'Session invalide ou expirée, reconnecte-toi.' });
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  next();
}
// Le bot doit être en ligne pour toute route qui lit/agit sur Discord en direct.
function requireBot(req, res, next) {
  if (!client || !client.isReady()) return res.status(503).json({ error: 'Le bot Discord n\'est pas connecté pour le moment.' });
  next();
}

app.post('/api/login', (req, res) => {
  if (!DASHBOARD_CODE) return res.status(500).json({ error: "DASHBOARD_CODE n'est pas configuré (variables d'environnement Render)." });
  const { code } = req.body || {};
  if (typeof code !== 'string' || code !== DASHBOARD_CODE) return res.status(401).json({ error: 'Code incorrect.' });
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  res.json({ token, expiresInMs: SESSION_TTL_MS });
});
app.post('/api/logout', requireAuth, (req, res) => {
  sessions.delete((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  res.json({ ok: true });
});

// ----------------------------------------------------------------
// STATUT / VUE D'ENSEMBLE
// ----------------------------------------------------------------
app.get('/api/status', requireAuth, (req, res) => {
  if (!client || !client.isReady()) {
    return res.json({ online: false, uptimeMs: Date.now() - startedAt, nodeVersion: process.version, dbStatus: db.getStatus() });
  }
  const guilds = [...client.guilds.cache.values()];
  res.json({
    online: true,
    tag: client.user.tag,
    avatar: client.user.displayAvatarURL(),
    ping: Math.max(0, Math.round(client.ws.ping)),
    guildCount: guilds.length,
    memberCount: guilds.reduce((s, g) => s + g.memberCount, 0),
    uptimeMs: Date.now() - startedAt,
    nodeVersion: process.version,
    dbStatus: db.getStatus(),
    ai: aiStats,
  });
});

app.get('/api/logs', requireAuth, (req, res) => {
  const type = req.query.type;
  const list = type && type !== 'all' ? recentLogs.filter((l) => l.type === type) : recentLogs;
  res.json(list.slice(0, 100));
});

// ----------------------------------------------------------------
// SERVEURS / SALONS / MEMBRES (réels, aucune valeur inventée)
// ----------------------------------------------------------------
app.get('/api/guilds', requireAuth, requireBot, (req, res) => {
  const guilds = [...client.guilds.cache.values()].map((g) => ({
    id: g.id, name: g.name, icon: g.iconURL({ size: 64 }), memberCount: g.memberCount,
    channelCount: g.channels.cache.size, ownerOfBot: g.members.me?.permissions.has('Administrator') || false,
  }));
  res.json(guilds.sort((a, b) => b.memberCount - a.memberCount));
});

const CHANNEL_TYPE_LABEL = { 0: 'texte', 2: 'vocal', 4: 'catégorie', 5: 'annonces', 13: 'vocal (stage)', 15: 'forum' };
app.get('/api/guilds/:id/channels', requireAuth, requireBot, (req, res) => {
  const guild = client.guilds.cache.get(req.params.id);
  if (!guild) return res.status(404).json({ error: 'Serveur introuvable (le bot n\'y est plus, ou mauvais ID).' });
  const me = guild.members.me;
  const channels = [...guild.channels.cache.values()]
    .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))
    .map((c) => {
      const perms = me ? c.permissionsFor(me) : null;
      return {
        id: c.id, name: c.name, type: c.type, typeLabel: CHANNEL_TYPE_LABEL[c.type] || `type ${c.type}`,
        parentId: c.parentId,
        canView: perms ? perms.has('ViewChannel') : false,
        canSend: perms ? (perms.has('ViewChannel') && perms.has('SendMessages')) : false,
      };
    });
  res.json(channels);
});

app.get('/api/guilds/:id/members', requireAuth, requireBot, async (req, res) => {
  const guild = client.guilds.cache.get(req.params.id);
  if (!guild) return res.status(404).json({ error: 'Serveur introuvable.' });
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  try {
    // On part du cache (peuplé par l'intent GuildMembers) ; s'il est trop
    // vide (bot qui vient de (re)démarrer), on complète par un vrai fetch.
    if (guild.members.cache.size < Math.min(limit, guild.memberCount)) await guild.members.fetch().catch(() => {});
    const members = [...guild.members.cache.values()].slice(0, limit).map((m) => ({
      id: m.id, tag: m.user.tag, bot: m.user.bot, avatar: m.user.displayAvatarURL({ size: 32 }),
      isOwner: m.id === guild.ownerId,
      topRole: m.roles.highest.id === guild.id ? null : m.roles.highest.name,
      joinedAt: m.joinedTimestamp,
    }));
    res.json({ total: guild.memberCount, members });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----------------------------------------------------------------
// MODÉRATION (cases réels stockés par db.js/addCase, pas des exemples)
// ----------------------------------------------------------------
app.get('/api/modcases', requireAuth, (req, res) => {
  const guildId = req.query.guildId;
  if (!guildId) return res.status(400).json({ error: 'guildId requis.' });
  const g = db.peek(guildId);
  if (!g) return res.json([]);
  res.json([...g.cases].reverse().slice(0, 200));
});

app.post('/api/modaction', requireAuth, requireBot, async (req, res) => {
  const { guildId, action, userId, reason, minutes } = req.body || {};
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return res.status(404).json({ error: 'Serveur introuvable.' });
  if (!['kick', 'ban', 'timeout', 'warn'].includes(action)) return res.status(400).json({ error: 'action invalide.' });
  const g = db.get(guildId);
  const finalReason = reason || 'Action lancée depuis le dashboard';
  try {
    const target = action !== 'ban' ? await guild.members.fetch(userId).catch(() => null) : null;
    if (action !== 'ban' && !target) return res.status(404).json({ error: "Ce membre n'est pas sur ce serveur." });
    if (action === 'kick') await target.kick(finalReason);
    if (action === 'ban') await guild.members.ban(userId, { reason: finalReason });
    if (action === 'timeout') await target.timeout(Math.max(1, parseInt(minutes, 10) || 10) * 60 * 1000, finalReason);
    const c = db.addCase(g, { type: action, userId, moderatorId: 'dashboard', reason: finalReason, extra: action === 'timeout' ? { minutes } : null });
    await db.save(guildId);
    pushLog('mod', `<b>${userId}</b> — ${action.toUpperCase()} via dashboard`);
    res.json({ ok: true, case: c });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/guildconfig', requireAuth, (req, res) => {
  const guildId = req.query.guildId;
  if (!guildId) return res.status(400).json({ error: 'guildId requis.' });
  const g = db.get(guildId);
  res.json({
    automod: g.automod, aiEnabled: g.aiEnabled, aiLanguage: g.aiLanguage, aiPersona: g.aiPersona,
    aiChannels: g.aiChannels, modLogChannelId: g.modLogChannelId, staffRoles: g.staffRoles,
  });
});
app.post('/api/guildconfig', requireAuth, async (req, res) => {
  const { guildId, patch } = req.body || {};
  if (!guildId || !patch) return res.status(400).json({ error: 'guildId et patch requis.' });
  const g = db.get(guildId);
  const ALLOWED = ['aiEnabled', 'aiLanguage', 'aiPersona', 'modLogChannelId'];
  for (const key of ALLOWED) if (patch[key] !== undefined) g[key] = patch[key];
  if (patch.automod) for (const key of Object.keys(patch.automod)) {
    if (g.automod[key] === undefined) continue;
    g.automod[key] = { ...g.automod[key], ...patch.automod[key] };
  }
  await db.save(guildId);
  res.json({ ok: true });
});

// ----------------------------------------------------------------
// AUTOMOD (config réelle lue/écrite via db.js)
// ----------------------------------------------------------------
app.get('/api/automod', requireAuth, (req, res) => {
  const guildId = req.query.guildId;
  if (!guildId) return res.status(400).json({ error: 'guildId requis.' });
  res.json(db.get(guildId).automod);
});
app.post('/api/automod', requireAuth, async (req, res) => {
  const { guildId, patch } = req.body || {};
  if (!guildId || !patch) return res.status(400).json({ error: 'guildId et patch requis.' });
  const g = db.get(guildId);
  for (const key of Object.keys(patch)) {
    if (g.automod[key] === undefined) continue; // on ignore les clés inconnues, pas de casse silencieuse de structure
    g.automod[key] = { ...g.automod[key], ...patch[key] };
  }
  await db.save(guildId);
  res.json({ ok: true, automod: g.automod });
});

// ----------------------------------------------------------------
// PARLER EN TANT QUE BOT (envoi réel)
// ----------------------------------------------------------------
app.post('/api/send', requireAuth, requireBot, async (req, res) => {
  const { guildId, channelId, content } = req.body || {};
  if (!content || !content.trim()) return res.status(400).json({ error: 'Message vide.' });
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return res.status(404).json({ error: 'Serveur introuvable.' });
  const channel = guild.channels.cache.get(channelId);
  if (!channel || !channel.isTextBased()) return res.status(404).json({ error: 'Salon introuvable ou non textuel.' });
  const perms = channel.permissionsFor(guild.members.me);
  if (!perms?.has('SendMessages')) return res.status(403).json({ error: "Le bot n'a pas la permission d'écrire dans ce salon (voir \"Donner l'accès à tous les salons\" dans Paramètres)." });
  try {
    const msg = await channel.send(content);
    pushLog('msg', `Message envoyé dans <b>#${channel.name}</b> — via dashboard`);
    res.json({ ok: true, messageId: msg.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----------------------------------------------------------------
// DONNER L'ACCÈS AU BOT À TOUS LES SALONS
// Ajoute une permission explicite (Voir + Écrire + Historique + Vocal) au
// bot sur CHAQUE salon d'un ou de tous les serveurs, pour ne plus jamais
// avoir à le faire manuellement, salon par salon, dans Discord.
// Nécessite que le bot ait déjà "Gérer les salons" sur le serveur, sinon
// Discord refusera (répertorié dans "failed" par channel, pas une erreur
// globale).
// ----------------------------------------------------------------
async function grantAllChannels(guild) {
  const me = guild.members.me;
  const results = { succeeded: 0, failed: [] };
  for (const channel of guild.channels.cache.values()) {
    try {
      const overwrite = { ViewChannel: true };
      if (channel.isTextBased?.()) Object.assign(overwrite, { SendMessages: true, ReadMessageHistory: true, EmbedLinks: true, AttachFiles: true });
      if (channel.isVoiceBased?.()) Object.assign(overwrite, { Connect: true, Speak: true });
      await channel.permissionOverwrites.edit(me.id, overwrite);
      results.succeeded += 1;
    } catch (e) {
      results.failed.push({ id: channel.id, name: channel.name, error: e.message });
    }
  }
  return results;
}
app.post('/api/fixperms', requireAuth, requireBot, async (req, res) => {
  const { guildId } = req.body || {};
  try {
    if (guildId) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return res.status(404).json({ error: 'Serveur introuvable.' });
      const r = await grantAllChannels(guild);
      pushLog('sys', `Accès donné à tous les salons de <b>${guild.name}</b> (${r.succeeded} ok, ${r.failed.length} échec(s))`);
      return res.json({ [guild.id]: r });
    }
    const out = {};
    for (const guild of client.guilds.cache.values()) out[guild.id] = await grantAllChannels(guild);
    pushLog('sys', `Accès donné à tous les salons de ${client.guilds.cache.size} serveur(s)`);
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----------------------------------------------------------------
// VARIABLES D'ENVIRONNEMENT — jamais renvoyées en clair, juste "configuré / non".
// Les modifier se fait sur Render (Environment), pas ici : un champ texte
// qui prétend "sauvegarder" un token sans vraiment le faire serait trompeur.
// ----------------------------------------------------------------
app.get('/api/env', requireAuth, (req, res) => {
  res.json({
    DISCORD_TOKEN: !!process.env.DISCORD_TOKEN,
    MONGODB_URI: !!process.env.MONGODB_URI,
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    OWNER_ID: !!process.env.OWNER_ID,
    DASHBOARD_CODE: !!process.env.DASHBOARD_CODE,
  });
});

// ----------------------------------------------------------------
// CONTRÔLE (réel : redémarre vraiment le process / déconnecte vraiment Discord)
// ----------------------------------------------------------------
app.post('/api/control', requireAuth, (req, res) => {
  const { action } = req.body || {};
  if (action === 'restart') {
    res.json({ ok: true, message: 'Redémarrage...' });
    pushLog('sys', 'Redémarrage demandé depuis le dashboard');
    setTimeout(() => process.exit(0), 300); // Render relance le process automatiquement
    return;
  }
  if (action === 'offline') {
    if (client) client.destroy();
    pushLog('sys', 'Bot déconnecté de Discord depuis le dashboard (serveur web resté en ligne)');
    return res.json({ ok: true, message: 'Bot déconnecté de Discord (le serveur web reste actif).' });
  }
  if (action === 'reconnect') {
    if (!process.env.DISCORD_TOKEN) return res.status(500).json({ error: 'DISCORD_TOKEN manquant.' });
    if (client) client.login(process.env.DISCORD_TOKEN).catch((e) => console.error('Reconnexion échouée :', e.message));
    pushLog('sys', 'Reconnexion à Discord demandée depuis le dashboard');
    return res.json({ ok: true, message: 'Reconnexion en cours...' });
  }
  if (action === 'presence') {
    if (!client || !client.isReady()) return res.status(503).json({ error: 'Bot hors ligne.' });
    const { status, activityType, activityText } = req.body || {};
    try {
      client.user.setPresence({
        status: ['online', 'idle', 'dnd', 'invisible'].includes(status) ? status : 'online',
        activities: activityText ? [{ name: activityText, type: ['PLAYING', 'WATCHING', 'LISTENING'].indexOf(activityType) >= 0 ? ['PLAYING', 'WATCHING', 'LISTENING'].indexOf(activityType) : 3 }] : [],
      });
      pushLog('sys', `Présence mise à jour depuis le dashboard (${status})`);
      return res.json({ ok: true });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  res.status(400).json({ error: 'action inconnue (restart | offline | reconnect | presence).' });
});

// ----------------------------------------------------------------
// ROUTES RENDER + DASHBOARD STATIQUE
// ----------------------------------------------------------------
app.get('/', (req, res) => res.send('Mod Bot en ligne.'));
app.get('/health', (req, res) => res.send('ok'));
app.use('/panel', express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur web lancé sur le port ${PORT} — dashboard sur /panel`));

module.exports = { app, setClient, pushLog, recordAiExchange };
