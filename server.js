// server.js — Moon Bot
// Health check Render + toutes les routes API du dashboard.
// Démarre IMMÉDIATEMENT (avant MongoDB) : ne jamais await ici.
// index.js appelle setClient() + setDb() dès que le bot est prêt.

const express = require('express');
const path    = require('path');
const app     = express();
app.use(express.json());

// ── Shared state injecté par index.js ─────────────────────────────
let _client = null;
let _db     = null;
function setClient(c) { _client = c; }
function setDb(d)     { _db = d; }

// ── CORS ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-dashboard-secret');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Auth middleware (toutes les routes /api/*) ─────────────────────
// Le code moonthebest = process.env.DASHBOARD_SECRET (ou fallback hardcodé).
const DASHBOARD_SECRET = process.env.DASHBOARD_SECRET || 'moonthebest';
function auth(req, res, next) {
  const secret = req.headers['x-dashboard-secret'] || req.query.secret;
  if (secret !== DASHBOARD_SECRET) return res.status(401).json({ error: 'Non autorisé.' });
  next();
}

// ── Routes publiques ───────────────────────────────────────────────
app.get('/',        (req, res) => res.send('Moon Bot en ligne.'));
app.get('/health',  (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Dashboard HTML — servi directement par le bot
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ── Helper — guild ou 404 ─────────────────────────────────────────
function getGuild(guildId, res) {
  if (!_client) { res.status(503).json({ error: 'Bot pas encore prêt.' }); return null; }
  const guild = _client.guilds.cache.get(guildId);
  if (!guild) { res.status(404).json({ error: 'Serveur introuvable.' }); return null; }
  return guild;
}

// ═══════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════

// ── Statut global du bot ──────────────────────────────────────────
app.get('/api/bot', auth, (req, res) => {
  if (!_client) return res.status(503).json({ error: 'Bot pas encore prêt.' });
  const guilds = [..._client.guilds.cache.values()];
  const totalMembers = guilds.reduce((acc, g) => acc + (g.memberCount || 0), 0);
  res.json({
    username:     _client.user.username,
    discriminator:_client.user.discriminator,
    avatarURL:    _client.user.displayAvatarURL({ size: 64 }),
    id:           _client.user.id,
    online:       _client.ws.status === 0, // 0 = READY
    ping:         _client.ws.ping,
    uptime:       process.uptime(),
    guildCount:   guilds.length,
    totalMembers,
    dbStatus:     _db ? _db.getStatus() : null,
  });
});

// ── Liste des serveurs ────────────────────────────────────────────
app.get('/api/guilds', auth, (req, res) => {
  if (!_client) return res.status(503).json({ error: 'Bot pas encore prêt.' });
  const guilds = [..._client.guilds.cache.values()].map(g => ({
    id:          g.id,
    name:        g.name,
    iconURL:     g.iconURL({ size: 64 }),
    memberCount: g.memberCount,
    ownerId:     g.ownerId,
    channelCount:g.channels.cache.filter(c => c.type === 0 || c.type === 5).size,
    roleCount:   g.roles.cache.size,
    createdAt:   g.createdTimestamp,
  }));
  res.json(guilds);
});

// ── Channels d'un serveur ─────────────────────────────────────────
app.get('/api/guild/:id/channels', auth, (req, res) => {
  const guild = getGuild(req.params.id, res); if (!guild) return;
  const { ChannelType } = require('discord.js');
  const channels = [...guild.channels.cache.values()]
    .filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement || c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildForum)
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map(c => ({
      id:       c.id,
      name:     c.name,
      type:     c.type, // 0=text, 2=voice, 5=announce, 15=forum
      parentId: c.parentId,
      topic:    c.topic || null,
      position: c.rawPosition,
    }));
  res.json(channels);
});

// ── Membres d'un serveur (50 max sans fetch complet) ─────────────
app.get('/api/guild/:id/members', auth, async (req, res) => {
  const guild = getGuild(req.params.id, res); if (!guild) return;
  try {
    const members = await guild.members.fetch({ limit: 100 });
    const list = [...members.values()].map(m => ({
      id:          m.id,
      username:    m.user.username,
      displayName: m.displayName,
      avatarURL:   m.user.displayAvatarURL({ size: 32 }),
      bot:         m.user.bot,
      joinedAt:    m.joinedTimestamp,
      roles:       m.roles.cache
                    .filter(r => r.id !== guild.id)
                    .sort((a,b) => b.position - a.position)
                    .map(r => ({ id: r.id, name: r.name, color: r.hexColor })),
    }));
    res.json(list);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Cas de modération d'un serveur ───────────────────────────────
app.get('/api/guild/:id/cases', auth, (req, res) => {
  if (!_db) return res.status(503).json({ error: 'DB pas prête.' });
  const g = _db.peek(req.params.id);
  if (!g) return res.json([]);
  const limit = parseInt(req.query.limit) || 50;
  const cases = [...g.cases].reverse().slice(0, limit);
  res.json(cases);
});

// ── Config complète d'un serveur ─────────────────────────────────
app.get('/api/guild/:id/config', auth, (req, res) => {
  if (!_db) return res.status(503).json({ error: 'DB pas prête.' });
  const g = _db.get(req.params.id);
  res.json({
    staffRoles:       g.staffRoles,
    modLogChannelId:  g.modLogChannelId,
    automod:          g.automod,
    warnThresholds:   g.warnThresholds,
    aiEnabled:        g.aiEnabled,
    aiChannels:       g.aiChannels,
    aiLanguage:       g.aiLanguage,
    aiPersona:        g.aiPersona,
    tickets:          g.tickets,
    cmdPerms:         g.cmdPerms,
    caseCount:        g.cases.length,
    nextCaseId:       g.nextCaseId,
  });
});

// ── Modifier la config d'un serveur ──────────────────────────────
app.patch('/api/guild/:id/config', auth, async (req, res) => {
  if (!_db) return res.status(503).json({ error: 'DB pas prête.' });
  const g = _db.get(req.params.id);
  const allowed = ['automod','aiEnabled','aiChannels','aiLanguage','aiPersona','modLogChannelId','warnThresholds'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      if (key === 'automod' && typeof req.body[key] === 'object') {
        // merge profond pour ne pas écraser des sous-clés non envoyées
        for (const sub of Object.keys(req.body.automod)) {
          g.automod[sub] = { ...g.automod[sub], ...req.body.automod[sub] };
        }
      } else {
        g[key] = req.body[key];
      }
    }
  }
  await _db.save(req.params.id);
  res.json({ ok: true });
});

// ── Envoyer un message en tant que bot ───────────────────────────
app.post('/api/guild/:id/send', auth, async (req, res) => {
  const guild = getGuild(req.params.id, res); if (!guild) return;
  const { channelId, content } = req.body;
  if (!channelId || !content) return res.status(400).json({ error: 'channelId et content requis.' });
  const channel = guild.channels.cache.get(channelId);
  if (!channel || !channel.send) return res.status(404).json({ error: 'Salon introuvable ou non textuel.' });
  try {
    const msg = await channel.send(content);
    res.json({ ok: true, messageId: msg.id, channelName: channel.name, guildName: guild.name });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Action de modération ─────────────────────────────────────────
app.post('/api/guild/:id/mod', auth, async (req, res) => {
  const guild = getGuild(req.params.id, res); if (!guild) return;
  if (!_db) return res.status(503).json({ error: 'DB pas prête.' });
  const { action, userId, reason, durationMs } = req.body;
  if (!action || !userId) return res.status(400).json({ error: 'action et userId requis.' });
  const g = _db.get(guild.id);
  try {
    let targetMember = null;
    try { targetMember = await guild.members.fetch(userId); } catch(_) {}
    const botMember = guild.members.me;

    if (action === 'ban') {
      await guild.members.ban(userId, { reason: reason || 'Dashboard' });
      const c = _db.addCase(g, { type: 'ban', userId, moderatorId: _client.user.id, reason: reason || 'Dashboard' });
      await _db.save(guild.id);
      return res.json({ ok: true, case: c });
    }
    if (!targetMember) return res.status(404).json({ error: 'Membre introuvable sur le serveur.' });
    if (action === 'kick') {
      await targetMember.kick(reason || 'Dashboard');
      const c = _db.addCase(g, { type: 'kick', userId, moderatorId: _client.user.id, reason: reason || 'Dashboard' });
      await _db.save(guild.id);
      return res.json({ ok: true, case: c });
    }
    if (action === 'timeout') {
      const ms = durationMs || 3600000; // défaut 1h
      await targetMember.timeout(ms, reason || 'Dashboard');
      const c = _db.addCase(g, { type: 'timeout', userId, moderatorId: _client.user.id, reason: reason || 'Dashboard', extra: { ms } });
      await _db.save(guild.id);
      return res.json({ ok: true, case: c });
    }
    if (action === 'untimeout') {
      await targetMember.timeout(null);
      return res.json({ ok: true });
    }
    if (action === 'warn') {
      const c = _db.addCase(g, { type: 'warn', userId, moderatorId: _client.user.id, reason: reason || 'Dashboard' });
      const warnCount = g.cases.filter(x => x.type === 'warn' && x.userId === userId).length;
      await _db.save(guild.id);
      return res.json({ ok: true, case: c, warnCount });
    }
    if (action === 'unban') {
      await guild.members.unban(userId, reason || 'Dashboard');
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: `Action inconnue : ${action}` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Récupérer un message / supprimer ─────────────────────────────
app.post('/api/guild/:id/delete-message', auth, async (req, res) => {
  const guild = getGuild(req.params.id, res); if (!guild) return;
  const { channelId, messageId } = req.body;
  try {
    const channel = guild.channels.cache.get(channelId);
    if (!channel) return res.status(404).json({ error: 'Salon introuvable.' });
    await channel.messages.delete(messageId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Rôles d'un serveur ────────────────────────────────────────────
app.get('/api/guild/:id/roles', auth, (req, res) => {
  const guild = getGuild(req.params.id, res); if (!guild) return;
  const roles = [...guild.roles.cache.values()]
    .filter(r => r.id !== guild.id)
    .sort((a,b) => b.position - a.position)
    .map(r => ({ id: r.id, name: r.name, color: r.hexColor, managed: r.managed, memberCount: r.members.size }));
  res.json(roles);
});

// ── Logs récents (événements) ─────────────────────────────────────
// Le bot stocke les cas dans db.cases — on les renvoie formatés.
app.get('/api/guild/:id/logs', auth, (req, res) => {
  if (!_db) return res.status(503).json({ error: 'DB pas prête.' });
  const g = _db.peek(req.params.id);
  if (!g) return res.json([]);
  const limit = parseInt(req.query.limit) || 100;
  res.json([...g.cases].reverse().slice(0, limit));
});

// ── Statut DB ─────────────────────────────────────────────────────
app.get('/api/db', auth, (req, res) => {
  if (!_db) return res.status(503).json({ error: 'DB pas prête.' });
  res.json(_db.getStatus());
});

// ── Démarrage ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[dashboard] Serveur démarré sur le port ${PORT} — dashboard sur /dashboard`));

module.exports = { app, setClient, setDb };
