require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const db = require('./db');
const mod = require('./moderation');
const automod = require('./automod');
const ai = require('./ai');
const {
  Client, GatewayIntentBits, Partials, Events, PermissionFlagsBits, ChannelType,
  EmbedBuilder, REST, Routes, SlashCommandBuilder,
  ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');

process.on('unhandledRejection', (err) => console.error('Promesse rejetée non gérée :', err));
process.on('uncaughtException', (err) => console.error('Exception non gérée :', err));

// ----------------------------------------------------------------
// CONTEXTE SERVEUR POUR L'IA (salons + rôles), pour orienter les membres
// ----------------------------------------------------------------
// Reconstruit à chaque appel (pas de cache) : les salons/rôles peuvent
// changer entre deux messages, et c'est rapide (cache local de discord.js).
function buildServerContext(guild) {
  const channels = guild.channels.cache
    .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map((c) => `#${c.name} (<#${c.id}>)${c.topic ? ` — ${c.topic.slice(0, 80)}` : ''}`);

  const roles = guild.roles.cache
    .filter((r) => r.id !== guild.id && !r.managed) // pas @everyone, pas les rôles de bots
    .sort((a, b) => b.position - a.position)
    .map((r) => `@${r.name} (<@&${r.id}>)`);

  return [
    `Salons textuels (liste complète) :\n${channels.join('\n') || 'aucun'}`,
    `Rôles (liste complète) :\n${roles.join('\n') || 'aucun'}`,
  ].join('\n\n');
}

// Qui parle au bot, et avec quel(s) rôle(s) exactement (nom + ID) — pour que
// l'IA sache reconnaître qui elle a en face d'elle.
function buildSpeakerInfo(member) {
  if (!member) return null;
  const roles = member.roles.cache
    .filter((r) => r.id !== member.guild.id)
    .sort((a, b) => b.position - a.position)
    .map((r) => `@${r.name} (<@&${r.id}>)`);
  return `La personne qui te parle s'appelle ${member.displayName} (<@${member.id}>) et a le(s) rôle(s) suivant(s) : ${roles.length ? roles.join(', ') : 'aucun rôle particulier'}.`;
}

// Action de modération réelle, appelée par le chat IA (outil moderate_member)
// quand un membre du staff lui demande de kick/ban/timeout/warn quelqu'un.
// Revérifie TOUT côté serveur (permissions, hiérarchie) : ne fait jamais
// confiance à ce que l'IA a "décidé" — exactement les mêmes garde-fous que
// les commandes slash /kick /ban /timeout /warn.
async function executeModAction({ guild, actorMember, action, user_id, reason, duration }) {
  const g = await db.get(guild.id);
  if (!mod.hasModPerms(actorMember, g)) return { error: "Tu n'as pas la permission d'effectuer des actions de modération." };
  if (!user_id) return { error: 'user_id manquant.' };
  const targetMember = await guild.members.fetch(user_id).catch(() => null);
  const botMember = guild.members.me;
  const check = mod.canTarget(actorMember, targetMember, botMember);
  if (!check.ok) return { error: check.reason };
  const finalReason = reason || 'Demandé via le chat IA';

  try {
    if (action === 'kick') {
      if (!targetMember) return { error: "Cette personne n'est pas sur le serveur." };
      await targetMember.kick(finalReason);
      const c = db.addCase(g, { type: 'kick', userId: user_id, moderatorId: actorMember.id, reason: finalReason });
      await db.save(guild.id);
      await mod.postToModLog(client, g, mod.caseEmbed(c, guild.name));
      return { success: true, message: `${targetMember.user.tag} expulsé(e). Cas #${c.id}.` };
    }
    if (action === 'ban') {
      await guild.members.ban(user_id, { reason: finalReason });
      const c = db.addCase(g, { type: 'ban', userId: user_id, moderatorId: actorMember.id, reason: finalReason });
      await db.save(guild.id);
      await mod.postToModLog(client, g, mod.caseEmbed(c, guild.name));
      return { success: true, message: `Utilisateur (${user_id}) banni. Cas #${c.id}.` };
    }
    if (action === 'timeout') {
      const ms = mod.parseDuration(duration);
      if (!ms) return { error: "Durée invalide (ex: '10m', '2h', '1d')." };
      if (!targetMember) return { error: "Cette personne n'est pas sur le serveur." };
      await targetMember.timeout(ms, finalReason);
      const c = db.addCase(g, { type: 'timeout', userId: user_id, moderatorId: actorMember.id, reason: finalReason, extra: { ms } });
      await db.save(guild.id);
      await mod.postToModLog(client, g, mod.caseEmbed(c, guild.name));
      return { success: true, message: `${targetMember.user.tag} en sourdine pour ${mod.fmtDuration(ms)}. Cas #${c.id}.` };
    }
    if (action === 'warn') {
      if (!targetMember) return { error: "Cette personne n'est pas sur le serveur." };
      const c = db.addCase(g, { type: 'warn', userId: user_id, moderatorId: actorMember.id, reason: finalReason });
      const warnCount = g.cases.filter((x) => x.type === 'warn' && x.userId === user_id).length;
      await db.save(guild.id);
      await mod.postToModLog(client, g, mod.caseEmbed(c, guild.name));
      return { success: true, message: `${targetMember.user.tag} averti(e) (${warnCount} avertissement(s) au total). Cas #${c.id}.` };
    }
    return { error: `Action inconnue : ${action}` };
  } catch (e) {
    return { error: `Échec (${e.message}).` };
  }
}
function needsServerContext(text) {
  return /\b(salon|canal|channel|rôle|role|permission)s?\b/i.test(text);
}

// Télécharge automatiquement le binaire luau (Linux) au démarrage s'il est
// absent, pour que /deobf marche sans configuration manuelle sur Render.
// Ne bloque jamais le démarrage du bot : en cas d'échec, /deobf le signalera
// juste proprement au lieu de planter quoi que ce soit.
function downloadAndDeobf(url, name, extraArgs = []) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deobf_'));
  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const inputPath = path.join(tmpDir, safeName);
  return fetch(url)
    .then((r) => r.arrayBuffer())
    .then((buf) => { fs.writeFileSync(inputPath, Buffer.from(buf)); return runDeobfuscator(inputPath, extraArgs); })
    .then((result) => ({ ...result, tmpDir, safeName }))
    .catch((e) => ({ ok: false, error: e.message, tmpDir, safeName }));
}

async function ensureLuauBinary() {
  const binDir = path.join(DEOBF_DIR, 'bin');
  const luauPath = path.join(binDir, 'luau');
  if (!fs.existsSync(DEOBF_ENTRY) || fs.existsSync(luauPath)) return;
  try {
    console.log('[deobf] Binaire luau absent, téléchargement automatique...');
    fs.mkdirSync(binDir, { recursive: true });
    const rel = await fetch('https://api.github.com/repos/luau-lang/luau/releases/latest', { headers: { 'user-agent': 'panel-bot' } }).then((r) => r.json());
    const asset = (rel.assets || []).find((a) => /ubuntu/i.test(a.name) && a.name.endsWith('.zip'));
    if (!asset) { console.error('[deobf] Aucun binaire Linux (ubuntu) trouvé dans la dernière release luau-lang/luau.'); return; }
    const zipPath = path.join(binDir, 'luau.zip');
    const buf = await fetch(asset.browser_download_url).then((r) => r.arrayBuffer());
    fs.writeFileSync(zipPath, Buffer.from(buf));
    await new Promise((resolve) => {
      const p = spawn('unzip', ['-o', zipPath, '-d', binDir]);
      p.on('close', resolve);
      p.on('error', resolve);
    });
    fs.rm(zipPath, { force: true }, () => {});
    for (const f of ['luau', 'luau-ast']) {
      const fp = path.join(binDir, f);
      if (fs.existsSync(fp)) fs.chmodSync(fp, 0o755);
    }
    console.log(fs.existsSync(luauPath) ? '[deobf] Binaire luau installé ✅' : "[deobf] Échec : luau absent après extraction (`unzip` installé sur le serveur ?).");
  } catch (e) {
    console.error('[deobf] Installation automatique du binaire luau impossible :', e.message);
  }
}

// ----------------------------------------------------------------
// DÉOBFUSCATEUR LUA/LUAU (indépendant de l'IA — lance deobf/deob.py en
// sous-processus Python). Dossier attendu : ./deobf/deob.py à la racine du
// projet (copié depuis le zip fourni). Nécessite python3 sur le serveur et
// un binaire luau (Linux) dans deobf/bin/luau — voir deobf/CLAUDE.md.
// ----------------------------------------------------------------
const DEOBF_DIR = path.join(__dirname, 'deobf');
const DEOBF_ENTRY = path.join(DEOBF_DIR, 'deob.py');
const DEOBF_TIMEOUT_SEC = 90;

// Si le dossier deobf/ n'est pas là mais qu'un deobf.zip traine à la racine
// (upload web en un seul fichier, plus simple sur mobile qu'un dossier avec
// sous-dossiers), on l'extrait nous-mêmes au démarrage.
function ensureDeobfExtracted() {
  return new Promise((resolve) => {
    const zipPath = path.join(__dirname, 'deobf.zip');
    if (fs.existsSync(DEOBF_ENTRY)) { resolve(); return; }
    if (!fs.existsSync(zipPath)) { resolve(); return; }
    console.log('[deobf] deobf.zip détecté, extraction...');
    if (fs.existsSync(DEOBF_DIR)) fs.rmSync(DEOBF_DIR, { recursive: true, force: true }); // dossier cassé d'une tentative précédente
    const p = spawn('unzip', ['-o', zipPath, '-d', __dirname]);
    p.on('close', () => {
      console.log(fs.existsSync(DEOBF_ENTRY) ? '[deobf] Dossier deobf/ extrait avec succès ✅' : "[deobf] Échec de l'extraction de deobf.zip (vérifie que le zip contient bien un dossier deobf/ à sa racine).");
      resolve();
    });
    p.on('error', (e) => { console.error("[deobf] Impossible d'extraire deobf.zip :", e.message); resolve(); });
  });
}

function runDeobfuscator(inputPath, extraArgs = []) {
  return new Promise((resolve) => {
    if (!fs.existsSync(DEOBF_ENTRY)) {
      resolve({ ok: false, error: "Le dossier `deobf/` n'est pas présent à la racine du projet (voir deobf/CLAUDE.md pour l'installer)." });
      return;
    }
    const outPath = `${inputPath}.out.lua`;
    const args = [DEOBF_ENTRY, inputPath, '-o', outPath, '--timeout', String(DEOBF_TIMEOUT_SEC), '--debug', ...extraArgs];
    let proc;
    try {
      proc = spawn('python3', args, { cwd: DEOBF_DIR });
    } catch (e) {
      resolve({ ok: false, error: `Impossible de lancer python3 : ${e.message}` });
      return;
    }
    const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) { /* déjà terminé */ } }, (DEOBF_TIMEOUT_SEC + 20) * 1000);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => { clearTimeout(killer); resolve({ ok: false, error: `python3 introuvable ou erreur de lancement : ${e.message}` }); });
    proc.on('close', (code) => {
      clearTimeout(killer);
      if (code === 0 && fs.existsSync(outPath)) { resolve({ ok: true, outPath }); return; }
      const tail = stderr.trim().split('\n').filter(Boolean).slice(-8).join('\n');
      resolve({ ok: false, error: tail || `Échec (code de sortie ${code}).` });
    });
  });
}
const INSTANCE_ID = crypto.randomBytes(2).toString('hex');
const STARTED_AT = Date.now();
const dup = { count: 0, lastAt: null };
const isBotOwner = (userId) => !!process.env.OWNER_ID && userId === process.env.OWNER_ID;

// Lancée tout de suite (voir le bas du fichier). Le bot attend cette promesse
// avant de toucher aux données, mais ça ne bloque plus le démarrage du
// serveur web ni la connexion Discord (voir server.js / boot en bas).
const dbReadyPromise = db.initDb();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.Channel, Partials.GuildMember, Partials.Message],
});

// ----------------------------------------------------------------
// COMMANDES SLASH
// ----------------------------------------------------------------
const commands = [
  new SlashCommandBuilder().setName('kick').setDescription('Expulser un membre')
    .addUserOption((o) => o.setName('membre').setDescription('Le membre à expulser').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison')),

  new SlashCommandBuilder().setName('ban').setDescription('Bannir un membre')
    .addUserOption((o) => o.setName('membre').setDescription('Le membre à bannir').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison'))
    .addIntegerOption((o) => o.setName('supprimer_jours').setDescription('Supprimer ses messages des N derniers jours (0-7)').setMinValue(0).setMaxValue(7)),

  new SlashCommandBuilder().setName('unban').setDescription("Lever le bannissement d'un utilisateur")
    .addStringOption((o) => o.setName('id').setDescription("ID Discord de l'utilisateur").setRequired(true)),

  new SlashCommandBuilder().setName('timeout').setDescription('Mettre un membre en sourdine (timeout)')
    .addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true))
    .addStringOption((o) => o.setName('duree').setDescription('Ex: 10m, 2h, 1d (28 jours max)').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison')),

  new SlashCommandBuilder().setName('untimeout').setDescription('Lever le timeout de quelqu\'un')
    .addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true)),

  new SlashCommandBuilder().setName('warn').setDescription('Avertir un membre')
    .addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison').setRequired(true)),

  new SlashCommandBuilder().setName('warnings').setDescription('Voir les avertissements de quelqu\'un (les tiens si vide)')
    .addUserOption((o) => o.setName('membre').setDescription('Le membre'))
    .setDMPermission(false),

  new SlashCommandBuilder().setName('unwarn').setDescription('Retirer un avertissement par son numéro de cas')
    .addIntegerOption((o) => o.setName('cas').setDescription('Numéro du cas (voir /warnings)').setRequired(true)),

  new SlashCommandBuilder().setName('clear').setDescription('Supprimer des messages récents (moins de 14 jours)')
    .addIntegerOption((o) => o.setName('nombre').setDescription('Combien de messages (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
    .addUserOption((o) => o.setName('membre').setDescription('Ne supprimer que ses messages')),

  new SlashCommandBuilder().setName('slowmode').setDescription('Régler le mode lent d\'un salon')
    .addIntegerOption((o) => o.setName('secondes').setDescription('0 = désactivé, 21600 max').setRequired(true).setMinValue(0).setMaxValue(21600))
    .addChannelOption((o) => o.setName('salon').setDescription('Salon visé (celui-ci par défaut)')),

  new SlashCommandBuilder().setName('lock').setDescription('Verrouiller un salon (bloquer les messages pour @everyone)')
    .addChannelOption((o) => o.setName('salon').setDescription('Salon visé (celui-ci par défaut)'))
    .addStringOption((o) => o.setName('raison').setDescription('Raison')),

  new SlashCommandBuilder().setName('unlock').setDescription('Déverrouiller un salon')
    .addChannelOption((o) => o.setName('salon').setDescription('Salon visé (celui-ci par défaut)')),

  new SlashCommandBuilder().setName('lockdown').setDescription('Verrouiller TOUS les salons textuels du serveur')
    .addStringOption((o) => o.setName('raison').setDescription('Raison')),
  new SlashCommandBuilder().setName('unlockdown').setDescription('Déverrouiller tous les salons verrouillés par /lockdown'),

  new SlashCommandBuilder().setName('case').setDescription('Voir le détail d\'un cas de modération')
    .addIntegerOption((o) => o.setName('numero').setDescription('Numéro du cas').setRequired(true)),
  new SlashCommandBuilder().setName('modlogs').setDescription('Voir tout l\'historique de modération de quelqu\'un')
    .addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true)),
  new SlashCommandBuilder().setName('setmodlog').setDescription('Définir le salon des logs de modération')
    .addChannelOption((o) => o.setName('salon').setDescription('Le salon').setRequired(true).addChannelTypes(ChannelType.GuildText)),

  new SlashCommandBuilder().setName('staffrole').setDescription('Gérer qui peut utiliser les commandes de modération')
    .addSubcommand((s) => s.setName('add').setDescription('Autoriser un rôle').addRoleOption((o) => o.setName('role').setDescription('Le rôle').setRequired(true)))
    .addSubcommand((s) => s.setName('remove').setDescription('Retirer un rôle').addRoleOption((o) => o.setName('role').setDescription('Le rôle').setRequired(true)))
    .addSubcommand((s) => s.setName('list').setDescription('Voir la liste')),

  new SlashCommandBuilder().setName('warnactions').setDescription('Configurer les sanctions automatiques selon le nombre d\'avertissements')
    .addSubcommand((s) => s.setName('list').setDescription('Voir les paliers configurés'))
    .addSubcommand((s) => s.setName('set').setDescription('Définir un palier')
      .addIntegerOption((o) => o.setName('warns').setDescription('Nombre d\'avertissements déclenchant l\'action').setRequired(true).setMinValue(1))
      .addStringOption((o) => o.setName('action').setDescription('Action').setRequired(true).addChoices({ name: 'Timeout', value: 'timeout' }, { name: 'Kick', value: 'kick' }, { name: 'Ban', value: 'ban' }))
      .addIntegerOption((o) => o.setName('minutes').setDescription('Durée du timeout en minutes (si action = timeout)')))
    .addSubcommand((s) => s.setName('remove').setDescription('Supprimer un palier').addIntegerOption((o) => o.setName('warns').setDescription('Nombre d\'avertissements du palier').setRequired(true))),

  new SlashCommandBuilder().setName('automod').setDescription('Configurer la modération automatique')
    .addSubcommand((s) => s.setName('antilien').setDescription('Supprimer les invitations Discord')
      .addStringOption((o) => o.setName('etat').setDescription('on/off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })))
    .addSubcommand((s) => s.setName('antispam').setDescription('Anti-spam de messages')
      .addStringOption((o) => o.setName('etat').setDescription('on/off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }))
      .addIntegerOption((o) => o.setName('max_messages').setDescription('Nb de messages max'))
      .addIntegerOption((o) => o.setName('secondes').setDescription('Fenêtre en secondes'))
      .addIntegerOption((o) => o.setName('timeout_minutes').setDescription('Durée du timeout auto en minutes')))
    .addSubcommand((s) => s.setName('antimention').setDescription('Anti-spam de mentions')
      .addStringOption((o) => o.setName('etat').setDescription('on/off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }))
      .addIntegerOption((o) => o.setName('max_mentions').setDescription('Nb de mentions max par message'))
      .addIntegerOption((o) => o.setName('timeout_minutes').setDescription('Durée du timeout auto en minutes')))
    .addSubcommand((s) => s.setName('motsinterdits').setDescription('Filtrer des mots')
      .addStringOption((o) => o.setName('action').setDescription('Action').setRequired(true).addChoices({ name: 'ajouter', value: 'add' }, { name: 'retirer', value: 'remove' }, { name: 'liste', value: 'list' }, { name: 'on', value: 'on' }, { name: 'off', value: 'off' }))
      .addStringOption((o) => o.setName('mot').setDescription('Le mot (pour ajouter/retirer)')))
    .addSubcommand((s) => s.setName('antiraid').setDescription('Anti-raid (afflux anormal de nouveaux membres)')
      .addStringOption((o) => o.setName('etat').setDescription('on/off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }))
      .addIntegerOption((o) => o.setName('seuil').setDescription("Nb d'arrivées déclenchant l'alerte"))
      .addIntegerOption((o) => o.setName('fenetre_secondes').setDescription('Fenêtre en secondes'))
      .addIntegerOption((o) => o.setName('age_min_jours').setDescription('Âge de compte minimum jugé "sûr" (jours)'))
      .addStringOption((o) => o.setName('action').setDescription('Action sur les comptes suspects').addChoices({ name: 'Timeout 30 min', value: 'timeout' }, { name: 'Kick', value: 'kick' }, { name: 'Alerte seulement', value: 'alert_only' })))
    .addSubcommand((s) => s.setName('salonstrict').setDescription('Mode modérateur strict dans UN salon (anti-lien, anti-fichier, anti-spam, anti-raid)')
      .addChannelOption((o) => o.setName('salon').setDescription('Le salon à surveiller').setRequired(true))
      .addStringOption((o) => o.setName('etat').setDescription('on/off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }))),

  new SlashCommandBuilder().setName('vider').setDescription('Vider complètement un salon (efface TOUT son historique, même au-delà de 14 jours)')
    .addChannelOption((o) => o.setName('salon').setDescription('Salon à vider (celui-ci par défaut)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),

  new SlashCommandBuilder().setName('findcodes').setDescription('Retrouver des fichiers joints (par nom) envoyés dans un salon')
    .addChannelOption((o) => o.setName('salon').setDescription('Salon à fouiller').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addStringOption((o) => o.setName('recherche').setDescription('Nom (ou bout de nom / extension) du fichier à chercher, ex: "message" ou "txt"').setRequired(true))
    .addIntegerOption((o) => o.setName('limite').setDescription('Nb de messages récents à fouiller (défaut 300, max 1000)').setMinValue(20).setMaxValue(1000)),

  new SlashCommandBuilder().setName('ai').setDescription('Configurer le chat IA du bot')
    .addSubcommand((s) => s.setName('channel-add').setDescription('Le bot répondra à TOUS les messages de ce salon').addChannelOption((o) => o.setName('salon').setDescription('Le salon').setRequired(true)))
    .addSubcommand((s) => s.setName('channel-remove').setDescription('Retirer un salon de discussion IA').addChannelOption((o) => o.setName('salon').setDescription('Le salon').setRequired(true)))
    .addSubcommand((s) => s.setName('channel-list').setDescription('Voir les salons de discussion IA'))
    .addSubcommand((s) => s.setName('toggle').setDescription('Activer/désactiver la réponse quand le bot est mentionné').addStringOption((o) => o.setName('etat').setDescription('on/off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })))
    .addSubcommand((s) => s.setName('persona').setDescription('Personnalité/ton donné au bot').addStringOption((o) => o.setName('texte').setDescription('Ex: "réponds de façon très courte et fun"').setRequired(true)))
    .addSubcommand((s) => s.setName('reset').setDescription('Oublier ta conversation en cours avec le bot dans ce salon')),

  new SlashCommandBuilder().setName('ask').setDescription("Poser une question à l'IA (répond dans ta langue)")
    .addStringOption((o) => o.setName('question').setDescription('Ta question').setRequired(true)),

  new SlashCommandBuilder().setName('deobf').setDescription('Déobfusquer un script Lua/Luau protégé (indépendant de l\'IA)')
    .addAttachmentOption((o) => o.setName('fichier').setDescription('Le script .lua/.luau/.txt à déobfusquer').setRequired(true))
    .addBooleanOption((o) => o.setName('rapide').setDescription('Trace seulement, sans dévirtualisation (plus rapide, moins complet)')),

  new SlashCommandBuilder().setName('help').setDescription('Voir toutes les commandes'),
].map((c) => c.setDMPermission(false).toJSON());

const ownerCommands = [
  new SlashCommandBuilder().setName('diag').setDescription('(Toi uniquement) État du bot : stockage, doublons, serveurs'),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const body = [...commands, ...ownerCommands];

  // Vide les anciennes commandes globales (enregistrées avant ce correctif) —
  // sinon elles restent affichées EN PLUS des commandes par serveur, ce qui
  // donne des doublons dans Discord.
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [] });
    console.log('Anciennes commandes globales supprimées (pour éviter les doublons).');
  } catch (err) { console.error('Erreur suppression des commandes globales :', err); }

  // On enregistre UNIQUEMENT par serveur (pas en global) : c'est instantané,
  // alors que le global peut prendre jusqu'à 1h et cause des doublons si les
  // deux sont actifs en même temps.
  for (const guild of client.guilds.cache.values()) {
    try {
      await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, guild.id), { body });
      console.log(`Commandes enregistrées instantanément sur ${guild.name} (${guild.id}).`);
    } catch (err) {
      console.error(`Erreur enregistrement des commandes sur ${guild.name} (${guild.id}) :`, err);
    }
  }
}

// Un nouveau serveur ajoute le bot après le démarrage : on lui enregistre les
// commandes tout de suite (sinon il faudrait attendre le prochain redémarrage).
client.on(Events.GuildCreate, async (guild) => {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, guild.id), { body: [...commands, ...ownerCommands] });
    console.log(`Commandes enregistrées instantanément sur le nouveau serveur ${guild.name} (${guild.id}).`);
  } catch (err) {
    console.error(`Erreur enregistrement des commandes sur ${guild.name} (${guild.id}) :`, err);
  }
});

// ----------------------------------------------------------------
// /help — court et pratique : un menu déroulant, une catégorie à la fois
// (au lieu d'un mur de texte avec tout d'un coup).
// ----------------------------------------------------------------
const HELP_CATEGORIES = {
  mod: {
    label: '🔨 Modération',
    text: [
      '`/kick` `/ban` `/unban` — expulser, bannir, débannir',
      '`/timeout` `/untimeout` — sourdine temporaire, ou lever',
      '`/warn` `/warnings` `/unwarn` — avertir, consulter, annuler',
      '`/clear` `/vider` — supprimer des messages, ou tout un salon',
      '`/slowmode` `/lock` `/unlock` `/lockdown` `/unlockdown`',
    ].join('\n'),
  },
  hist: {
    label: '📜 Historique',
    text: '`/case` — détail d\'une sanction précise\n`/modlogs` — historique complet d\'un membre',
  },
  config: {
    label: '⚙️ Configuration',
    text: [
      '`/setmodlog` — salon des logs',
      '`/staffrole` — qui peut modérer',
      '`/warnactions` — sanctions auto selon le nb d\'avertissements',
    ].join('\n'),
  },
  automod: {
    label: '🛡️ Automod',
    text: [
      '`/automod antilien/antispam/antimention/motsinterdits/grosmots/antiraid`',
      '`/automod salonstrict` — mode "modérateur strict" dans un salon choisi : bloque tout lien et fichier, spam et raid supprimés automatiquement.',
    ].join('\n'),
  },
  recherche: {
    label: '🔍 Recherche',
    text: '`/findcodes` — retrouve des fichiers joints par nom (ex: "txt", "message") dans un salon, et te renvoie les fichiers eux-mêmes.',
  },
  ia: {
    label: '🤖 IA',
    text: '`/ask` — poser une question\n`/ai` — réglages (salons, personnalité...)\n💬 Mentionne le bot pour discuter, dans n\'importe quelle langue.',
  },
  deobf: {
    label: '🧩 Déobfuscation',
    text: '`/deobf` — envoie un script `.lua`/`.luau`, récupère une version lisible.',
  },
};

function buildHelpEmbed(key, guild) {
  const cat = HELP_CATEGORIES[key] || HELP_CATEGORIES.mod;
  return new EmbedBuilder()
    .setColor(mod.COLORS.info)
    .setAuthor({ name: guild.name, iconURL: guild.iconURL() || undefined })
    .setTitle(`📘 ${cat.label}`)
    .setDescription(cat.text)
    .setFooter({ text: 'Choisis une autre catégorie ci-dessous · commandes (staff) = permission requise' });
}
function buildHelpRow(selected) {
  const menu = new StringSelectMenuBuilder().setCustomId('help_select').setPlaceholder('Choisir une catégorie...')
    .addOptions(Object.entries(HELP_CATEGORIES).map(([value, cat]) => ({ label: cat.label, value, default: value === selected })));
  return new ActionRowBuilder().addComponents(menu);
}
async function routeSelect(interaction) {
  if (!interaction.guild) return;

  if (interaction.customId === 'help_select') {
    const key = interaction.values[0];
    await interaction.update({ embeds: [buildHelpEmbed(key, interaction.guild)], components: [buildHelpRow(key)] });
    return;
  }

  if (interaction.customId === 'findcodes_select') {
    const value = interaction.values[0];
    const [msgId, attIndexStr, channelId] = value.split(':');
    await interaction.deferReply({ ephemeral: true });
    try {
      const targetChannel = interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null);
      if (!targetChannel) { await interaction.editReply(`❌ Salon introuvable (peut-être supprimé).`); return; }
      const msg = await targetChannel.messages.fetch(msgId);
      const att = [...msg.attachments.values()][parseInt(attIndexStr, 10)];
      if (!att) { await interaction.editReply(`❌ Fichier introuvable dans le message.`); return; }
      const fileData = Buffer.from(await (await fetch(att.url)).arrayBuffer());
      const attachment = { file: fileData, name: att.name };
      await interaction.editReply({ content: `📥 **${att.name}** (${(att.size / 1024).toFixed(1)} KB)`, files: [attachment] });
    } catch (e) {
      await interaction.editReply(`❌ Erreur lors du téléchargement (${e.message}).`);
    }
    return;
  }

  if (interaction.customId.startsWith('findcodes_dl_')) {
    const parts = interaction.customId.split('_');
    const msgId = parts[2];
    const attIndex = parseInt(parts[3], 10) || 0;
    const channelId = parts[4];
    await interaction.deferReply({ ephemeral: true });
    try {
      const targetChannel = interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null);
      if (!targetChannel) { await interaction.editReply(`❌ Salon introuvable (peut-être supprimé).`); return; }
      const msg = await targetChannel.messages.fetch(msgId);
      const att = [...msg.attachments.values()][attIndex];
      if (!att) { await interaction.editReply(`❌ Fichier introuvable.`); return; }
      const fileData = Buffer.from(await (await fetch(att.url)).arrayBuffer());
      if (fileData.length > 25 * 1024 * 1024) { await interaction.editReply(`❌ Fichier trop volumineux (${(fileData.length / 1024 / 1024).toFixed(1)} MB, max 25 MB).`); return; }
      const attachment = { file: fileData, name: att.name };
      await interaction.editReply({ content: `📥 **${att.name}** (${(att.size / 1024).toFixed(1)} KB)`, files: [attachment] });
    } catch (e) {
      await interaction.editReply(`❌ Erreur (${e.message}).`);
    }
    return;
  }
}



// ----------------------------------------------------------------
// DÉMARRAGE / SUIVI DE VIE
// ----------------------------------------------------------------
client.once(Events.ClientReady, async () => {
  console.log(`Connecté en tant que ${client.user.tag} (instance ${INSTANCE_ID})`);
  await dbReadyPromise;
  console.log(`Serveurs actuels (${client.guilds.cache.size}) :`, [...client.guilds.cache.values()].map((g) => `${g.name} (${g.id})`).join(' | '));
  await registerCommands();
  const st = db.getStatus();
  if (!st.persistent && process.env.OWNER_ID) {
    try {
      const u = await client.users.fetch(process.env.OWNER_ID);
      await u.send(`⚠️ Le bot tourne SANS stockage persistant. Raison : ${st.uriSet ? `MongoDB inaccessible (${st.connectError || '?'})` : 'MONGODB_URI absent'}.`);
    } catch (e) { /* MP fermés, tant pis */ }
  }
});

// ----------------------------------------------------------------
// MODÉRATION MANUELLE
// ----------------------------------------------------------------
async function handleModCommand(interaction, guild, g) {
  const cmd = interaction.commandName;
  const L = (fr) => fr; // point d'extension simple si un jour tu veux traduire
  const reply = (content, extra = {}) => interaction.editReply({ content, allowedMentions: { parse: [] }, ...extra });
  const botMember = guild.members.me;

  if (cmd === 'kick' || cmd === 'ban' || cmd === 'timeout' || cmd === 'untimeout' || cmd === 'warn') {
    const target = interaction.options.getUser('membre');
    const reason = interaction.options.getString('raison') || 'Aucune raison fournie';
    const targetMember = await guild.members.fetch(target.id).catch(() => null);
    const check = mod.canTarget(interaction.member, targetMember, botMember);
    if (!check.ok) { await reply(`❌ ${check.reason}`); return; }

    if (cmd === 'kick') {
      if (!targetMember) { await reply("❌ Cette personne n'est pas sur le serveur."); return; }
      try { await targetMember.kick(reason); } catch (e) { await reply(`❌ Impossible d'expulser (${e.message}).`); return; }
      const c = db.addCase(g, { type: 'kick', userId: target.id, moderatorId: interaction.user.id, reason });
      await db.save(guild.id);
      await mod.postToModLog(client, g, mod.caseEmbed(c, guild.name));
      await reply(`👢 **${target.tag}** expulsé(e). Cas #${c.id}.`);
      return;
    }

    if (cmd === 'ban') {
      const deleteDays = interaction.options.getInteger('supprimer_jours') || 0;
      try { await guild.members.ban(target.id, { reason, deleteMessageSeconds: deleteDays * 86400 }); }
      catch (e) { await reply(`❌ Impossible de bannir (${e.message}).`); return; }
      const c = db.addCase(g, { type: 'ban', userId: target.id, moderatorId: interaction.user.id, reason });
      await db.save(guild.id);
      await mod.postToModLog(client, g, mod.caseEmbed(c, guild.name));
      await reply(`🔨 **${target.tag}** banni(e). Cas #${c.id}.`);
      return;
    }

    if (cmd === 'timeout') {
      const durationStr = interaction.options.getString('duree');
      const ms = mod.parseDuration(durationStr);
      if (!ms) { await reply('❌ Durée invalide. Exemples valides : `10m`, `2h`, `1d`.'); return; }
      if (!targetMember) { await reply("❌ Cette personne n'est pas sur le serveur."); return; }
      try { await targetMember.timeout(ms, reason); } catch (e) { await reply(`❌ Impossible (${e.message}).`); return; }
      const c = db.addCase(g, { type: 'timeout', userId: target.id, moderatorId: interaction.user.id, reason, extra: { ms } });
      await db.save(guild.id);
      await mod.postToModLog(client, g, mod.caseEmbed(c, guild.name));
      await reply(`🔇 **${target.tag}** en sourdine pour ${mod.fmtDuration(ms)}. Cas #${c.id}.`);
      return;
    }

    if (cmd === 'untimeout') {
      if (!targetMember) { await reply("❌ Cette personne n'est pas sur le serveur."); return; }
      try { await targetMember.timeout(null); } catch (e) { await reply(`❌ Impossible (${e.message}).`); return; }
      const c = db.addCase(g, { type: 'untimeout', userId: target.id, moderatorId: interaction.user.id, reason: 'Levée manuelle' });
      await db.save(guild.id);
      await mod.postToModLog(client, g, mod.caseEmbed(c, guild.name));
      await reply(`🔊 Timeout levé pour **${target.tag}**.`);
      return;
    }

    if (cmd === 'warn') {
      const c = db.addCase(g, { type: 'warn', userId: target.id, moderatorId: interaction.user.id, reason });
      const warnCount = g.cases.filter((x) => x.type === 'warn' && x.userId === target.id).length;
      let escalationMsg = '';
      const esc = mod.computeWarnEscalation(g, warnCount);
      if (esc && targetMember) {
        try {
          if (esc.action === 'timeout') { await targetMember.timeout(esc.minutes * 60000, `Escalade automatique : ${warnCount} avertissements`); escalationMsg = `\n⚙️ Escalade auto : timeout ${esc.minutes} min (${warnCount} avertissements).`; }
          else if (esc.action === 'kick') { await targetMember.kick(`Escalade automatique : ${warnCount} avertissements`); escalationMsg = `\n⚙️ Escalade auto : expulsion (${warnCount} avertissements).`; }
          else if (esc.action === 'ban') { await guild.members.ban(target.id, { reason: `Escalade automatique : ${warnCount} avertissements` }); escalationMsg = `\n⚙️ Escalade auto : bannissement (${warnCount} avertissements).`; }
          db.addCase(g, { type: esc.action, userId: target.id, moderatorId: null, reason: `Escalade automatique après ${warnCount} avertissements` });
        } catch (e) { escalationMsg = `\n⚠️ Escalade prévue mais échouée (${e.message}).`; }
      }
      await db.save(guild.id);
      await mod.postToModLog(client, g, mod.caseEmbed(c, guild.name));
      await reply(`⚠️ **${target.tag}** averti(e) (${warnCount} avertissement(s) au total). Cas #${c.id}.${escalationMsg}`);
      return;
    }
  }

  if (cmd === 'unban') {
    const id = interaction.options.getString('id').trim();
    try { await guild.members.unban(id); } catch (e) { await reply(`❌ Impossible (${e.message}). Vérifie que l'ID est correct et bien banni.`); return; }
    const c = db.addCase(g, { type: 'unban', userId: id, moderatorId: interaction.user.id, reason: 'Levée manuelle du ban' });
    await db.save(guild.id);
    await mod.postToModLog(client, g, mod.caseEmbed(c, guild.name));
    await reply(`✅ Ban levé pour \`${id}\`.`);
    return;
  }

  if (cmd === 'warnings' || cmd === 'modlogs') {
    const target = interaction.options.getUser('membre') || interaction.user;
    if (cmd === 'warnings' && target.id !== interaction.user.id && !mod.hasModPerms(interaction.member, g)) {
      await reply("❌ Tu ne peux voir que tes propres avertissements."); return;
    }
    const cases = g.cases.filter((c) => c.userId === target.id && (cmd === 'modlogs' || c.type === 'warn'));
    if (cases.length === 0) { await reply(`Aucun ${cmd === 'warnings' ? 'avertissement' : 'historique'} pour **${target.tag}**.`); return; }
    const embed = new EmbedBuilder().setColor(mod.COLORS.info).setTitle(`${cmd === 'warnings' ? '⚠️ Avertissements' : '📁 Historique'} — ${target.tag}`)
      .setDescription(cases.slice(-20).reverse().map((c) => `**#${c.id}** [${c.type}] — ${c.reason} (<t:${Math.floor(c.createdAt / 1000)}:R>)`).join('\n').slice(0, 4000));
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (cmd === 'unwarn') {
    const caseId = interaction.options.getInteger('cas');
    const idx = g.cases.findIndex((c) => c.id === caseId && c.type === 'warn');
    if (idx === -1) { await reply('❌ Aucun avertissement avec ce numéro.'); return; }
    g.cases.splice(idx, 1);
    await db.save(guild.id);
    await reply(`✅ Avertissement #${caseId} retiré.`);
    return;
  }

  if (cmd === 'case') {
    const c = g.cases.find((x) => x.id === interaction.options.getInteger('numero'));
    if (!c) { await reply('❌ Cas introuvable.'); return; }
    await interaction.editReply({ embeds: [mod.caseEmbed(c, guild.name)] });
    return;
  }

  if (cmd === 'clear') {
    const amount = interaction.options.getInteger('nombre');
    const targetUser = interaction.options.getUser('membre');
    try {
      const fetched = await interaction.channel.messages.fetch({ limit: 100 });
      const toDelete = (targetUser ? fetched.filter((m) => m.author.id === targetUser.id) : fetched).first(amount);
      const deleted = await interaction.channel.bulkDelete(toDelete, true);
      await reply(`🧹 ${deleted.size} message(s) supprimé(s). (Discord ne permet de supprimer en masse que les messages de moins de 14 jours.)`);
    } catch (e) { await reply(`❌ Erreur (${e.message}).`); }
    return;
  }

  if (cmd === 'slowmode') {
    const seconds = interaction.options.getInteger('secondes');
    const channel = interaction.options.getChannel('salon') || interaction.channel;
    try { await channel.setRateLimitPerUser(seconds); await reply(`🐢 Mode lent de ${channel} réglé à ${seconds}s.`); }
    catch (e) { await reply(`❌ Erreur (${e.message}).`); }
    return;
  }

  if (cmd === 'lock' || cmd === 'unlock') {
    const channel = interaction.options.getChannel('salon') || interaction.channel;
    const everyone = guild.roles.everyone;
    if (cmd === 'lock') {
      const current = channel.permissionOverwrites.cache.get(everyone.id);
      const prev = current ? (current.deny.has(PermissionFlagsBits.SendMessages) ? false : current.allow.has(PermissionFlagsBits.SendMessages) ? true : null) : null;
      g.lockedChannels[channel.id] = prev;
      await channel.permissionOverwrites.edit(everyone, { SendMessages: false });
      await db.save(guild.id);
      await reply(`🔒 ${channel} verrouillé.${interaction.options.getString('raison') ? ` Raison : ${interaction.options.getString('raison')}` : ''}`);
    } else {
      const prev = Object.prototype.hasOwnProperty.call(g.lockedChannels, channel.id) ? g.lockedChannels[channel.id] : null;
      await channel.permissionOverwrites.edit(everyone, { SendMessages: prev });
      delete g.lockedChannels[channel.id];
      await db.save(guild.id);
      await reply(`🔓 ${channel} déverrouillé.`);
    }
    return;
  }

  if (cmd === 'lockdown' || cmd === 'unlockdown') {
    const everyone = guild.roles.everyone;
    const textChannels = guild.channels.cache.filter((c) => c.type === ChannelType.GuildText);
    let count = 0;
    if (cmd === 'lockdown') {
      for (const channel of textChannels.values()) {
        try {
          const current = channel.permissionOverwrites.cache.get(everyone.id);
          const prev = current ? (current.deny.has(PermissionFlagsBits.SendMessages) ? false : current.allow.has(PermissionFlagsBits.SendMessages) ? true : null) : null;
          g.lockedChannels[channel.id] = prev;
          await channel.permissionOverwrites.edit(everyone, { SendMessages: false });
          count++;
        } catch (e) { /* pas les perms sur ce salon, on passe */ }
      }
      await db.save(guild.id);
      await reply(`🔒 Lockdown : ${count} salon(s) verrouillé(s).${interaction.options.getString('raison') ? ` Raison : ${interaction.options.getString('raison')}` : ''}`);
    } else {
      for (const [channelId, prev] of Object.entries(g.lockedChannels)) {
        const channel = guild.channels.cache.get(channelId);
        if (!channel) continue;
        try { await channel.permissionOverwrites.edit(everyone, { SendMessages: prev }); count++; } catch (e) { /* salon supprimé / perms */ }
      }
      g.lockedChannels = {};
      await db.save(guild.id);
      await reply(`🔓 Lockdown levé : ${count} salon(s) déverrouillé(s).`);
    }
    return;
  }

  if (cmd === 'setmodlog') {
    g.modLogChannelId = interaction.options.getChannel('salon').id;
    await db.save(guild.id);
    await reply(`✅ Salon de logs réglé sur <#${g.modLogChannelId}>.`);
    return;
  }

  if (cmd === 'staffrole') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'add') {
      const role = interaction.options.getRole('role');
      if (role.id === guild.id) { await reply('❌ Impossible avec @everyone.'); return; }
      if (!g.staffRoles.includes(role.id)) g.staffRoles.push(role.id);
      await db.save(guild.id);
      await reply(`✅ <@&${role.id}> peut maintenant modérer.`);
    } else if (sub === 'remove') {
      const role = interaction.options.getRole('role');
      g.staffRoles = g.staffRoles.filter((r) => r !== role.id);
      await db.save(guild.id);
      await reply(`✅ <@&${role.id}> ne peut plus modérer.`);
    } else {
      await reply(`🎭 Rôles autorisés : ${g.staffRoles.map((r) => `<@&${r}>`).join(' ') || 'aucun (Administrateur/Gérer le serveur uniquement)'}`);
    }
    return;
  }

  if (cmd === 'warnactions') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'set') {
      const warns = interaction.options.getInteger('warns');
      const action = interaction.options.getString('action');
      const minutes = interaction.options.getInteger('minutes') || 60;
      g.warnThresholds = g.warnThresholds.filter((t) => t.count !== warns);
      g.warnThresholds.push({ count: warns, action, minutes: action === 'timeout' ? minutes : null });
      g.warnThresholds.sort((a, b) => a.count - b.count);
      await db.save(guild.id);
      await reply(`✅ À partir de ${warns} avertissements : ${action}${action === 'timeout' ? ` (${minutes} min)` : ''}.`);
    } else if (sub === 'remove') {
      const warns = interaction.options.getInteger('warns');
      g.warnThresholds = g.warnThresholds.filter((t) => t.count !== warns);
      await db.save(guild.id);
      await reply(`✅ Palier à ${warns} avertissements supprimé.`);
    } else {
      const list = g.warnThresholds.length ? g.warnThresholds.map((t) => `• ${t.count} avertissements → **${t.action}**${t.minutes ? ` (${t.minutes} min)` : ''}`).join('\n') : 'Aucun palier configuré.';
      await reply(list);
    }
    return;
  }

  if (cmd === 'automod') {
    const sub = interaction.options.getSubcommand();
    const am = g.automod;
    if (sub === 'antilien') {
      am.antiLink.enabled = interaction.options.getString('etat') === 'on';
      await db.save(guild.id); await reply(`✅ Anti-lien : ${am.antiLink.enabled ? 'activé' : 'désactivé'}.`); return;
    }
    if (sub === 'antispam') {
      am.antiSpam.enabled = interaction.options.getString('etat') === 'on';
      if (interaction.options.getInteger('max_messages')) am.antiSpam.maxMessages = interaction.options.getInteger('max_messages');
      if (interaction.options.getInteger('secondes')) am.antiSpam.perSeconds = interaction.options.getInteger('secondes');
      if (interaction.options.getInteger('timeout_minutes')) am.antiSpam.timeoutMinutes = interaction.options.getInteger('timeout_minutes');
      await db.save(guild.id);
      await reply(`✅ Anti-spam : ${am.antiSpam.enabled ? 'activé' : 'désactivé'} (max ${am.antiSpam.maxMessages} msg / ${am.antiSpam.perSeconds}s → timeout ${am.antiSpam.timeoutMinutes} min).`);
      return;
    }
    if (sub === 'antimention') {
      am.antiMention.enabled = interaction.options.getString('etat') === 'on';
      if (interaction.options.getInteger('max_mentions')) am.antiMention.maxMentions = interaction.options.getInteger('max_mentions');
      if (interaction.options.getInteger('timeout_minutes')) am.antiMention.timeoutMinutes = interaction.options.getInteger('timeout_minutes');
      await db.save(guild.id);
      await reply(`✅ Anti-mention : ${am.antiMention.enabled ? 'activé' : 'désactivé'} (max ${am.antiMention.maxMentions} mentions → timeout ${am.antiMention.timeoutMinutes} min).`);
      return;
    }
    if (sub === 'motsinterdits') {
      const action = interaction.options.getString('action');
      const mot = interaction.options.getString('mot');
      if (action === 'add') { if (!mot) { await reply('❌ Précise un mot.'); return; } am.badWords.words.push(mot.toLowerCase()); }
      else if (action === 'remove') { am.badWords.words = am.badWords.words.filter((w) => w !== (mot || '').toLowerCase()); }
      else if (action === 'on') am.badWords.enabled = true;
      else if (action === 'off') am.badWords.enabled = false;
      else { await reply(`📋 Mots filtrés : ${am.badWords.words.join(', ') || 'aucun'} (${am.badWords.enabled ? 'activé' : 'désactivé'})`); return; }
      await db.save(guild.id);
      await reply(`✅ Fait. Mots filtrés : ${am.badWords.words.join(', ') || 'aucun'} (${am.badWords.enabled ? 'activé' : 'désactivé'}).`);
      return;
    }
    if (sub === 'antiraid') {
      am.antiRaid.enabled = interaction.options.getString('etat') === 'on';
      if (interaction.options.getInteger('seuil')) am.antiRaid.joinThreshold = interaction.options.getInteger('seuil');
      if (interaction.options.getInteger('fenetre_secondes')) am.antiRaid.windowSeconds = interaction.options.getInteger('fenetre_secondes');
      if (interaction.options.getInteger('age_min_jours')) am.antiRaid.minAccountAgeDays = interaction.options.getInteger('age_min_jours');
      if (interaction.options.getString('action')) am.antiRaid.action = interaction.options.getString('action');
      await db.save(guild.id);
      await reply(`✅ Anti-raid : ${am.antiRaid.enabled ? 'activé' : 'désactivé'} (seuil ${am.antiRaid.joinThreshold}/${am.antiRaid.windowSeconds}s, âge min ${am.antiRaid.minAccountAgeDays}j, action: ${am.antiRaid.action}).`);
      return;
    }
    if (sub === 'salonstrict') {
      const channel = interaction.options.getChannel('salon');
      const on = interaction.options.getString('etat') === 'on';
      am.strictChannels = am.strictChannels || [];
      if (on && !am.strictChannels.includes(channel.id)) am.strictChannels.push(channel.id);
      if (!on) am.strictChannels = am.strictChannels.filter((id) => id !== channel.id);
      await db.save(guild.id);
      await reply(on
        ? `🛡️ Mode modérateur strict **activé** dans ${channel} : tout lien, tout fichier envoyé, le spam et un afflux suspect de messages seront supprimés automatiquement.`
        : `✅ Mode modérateur strict désactivé dans ${channel}.`);
      return;
    }
  }

  if (cmd === 'ai') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'channel-add') {
      const channel = interaction.options.getChannel('salon');
      if (!g.aiChannels.includes(channel.id)) g.aiChannels.push(channel.id);
      await db.save(guild.id); await reply(`✅ Le bot va discuter librement dans ${channel}.`); return;
    }
    if (sub === 'channel-remove') {
      const channel = interaction.options.getChannel('salon');
      g.aiChannels = g.aiChannels.filter((c) => c !== channel.id);
      await db.save(guild.id); await reply(`✅ Retiré : ${channel}.`); return;
    }
    if (sub === 'channel-list') { await reply(`💬 Salons IA : ${g.aiChannels.map((c) => `<#${c}>`).join(' ') || 'aucun'}`); return; }
    if (sub === 'toggle') { g.aiEnabled = interaction.options.getString('etat') === 'on'; await db.save(guild.id); await reply(`✅ Réponse aux mentions : ${g.aiEnabled ? 'activée' : 'désactivée'}.`); return; }
    if (sub === 'persona') { g.aiPersona = interaction.options.getString('texte'); await db.save(guild.id); await reply('✅ Personnalité mise à jour.'); return; }
    if (sub === 'reset') { ai.resetHistory(interaction.channelId, interaction.user.id); await reply('🧹 Conversation oubliée.'); return; }
  }

  if (cmd === 'vider') {
    const channel = interaction.options.getChannel('salon') || interaction.channel;
    await reply(`🧹 Vidage de ${channel} en cours (clonage + suppression de l'ancien salon)...`);
    try {
      const clone = await channel.clone({ reason: `Salon vidé par ${interaction.user.tag}` });
      await clone.setPosition(channel.rawPosition ?? 0).catch(() => {});
      await channel.delete(`Salon vidé par ${interaction.user.tag}`).catch(() => {});
      await clone.send(`🧹 Salon vidé par ${interaction.user}.`).catch(() => {});
    } catch (e) {
      await interaction.followUp({ content: `❌ Erreur pendant le vidage (${e.message}).`, ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (cmd === 'findcodes') {
    const channel = interaction.options.getChannel('salon');
    const rawQuery = interaction.options.getString('recherche');
    const limite = interaction.options.getInteger('limite') || 10000;  // très haut pour fouiller le salon entier
    const perms = channel.permissionsFor(botMember);
    if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms?.has(PermissionFlagsBits.ReadMessageHistory)) { await reply(`❌ Je n'ai pas accès à l'historique de ${channel}.`); return; }

    await reply(`🔍 Fouille du salon entier en cours...`);

    const normalize = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const terms = normalize(rawQuery).split(/\s+/).filter(Boolean);

    let allFiles = [], fetched = 0, lastId;
    while (fetched < limite) {
      const batch = await channel.messages.fetch({ limit: Math.min(100, limite - fetched), ...(lastId ? { before: lastId } : {}) }).catch(() => null);
      if (!batch || !batch.size) break;
      fetched += batch.size;
      lastId = batch.last().id;
      for (const m of batch.values()) {
        let attIndex = 0;
        for (const a of m.attachments.values()) {
          const fileName = normalize(a.name || '');
          if (terms.every((t) => fileName.includes(t))) {
            allFiles.push({ name: a.name, size: a.size, url: a.url, msgUrl: m.url, author: m.author.tag, createdAt: m.createdTimestamp, msgId: m.id, attIndex, channelId: channel.id });
          }
          attIndex += 1;
        }
      }
      if (batch.size < 100) break;  // fin du salon atteinte
    }

    if (!allFiles.length) { await interaction.editReply(`🔍 Aucun fichier nommé "${rawQuery}" dans ${channel} (${fetched} message(s) fouillé(s)).`); return; }

    allFiles.sort((a, b) => b.createdAt - a.createdAt);

    if (allFiles.length > 25) {
      const grouped = allFiles.slice(0, 25).map((f, i) => {
        const sizeStr = (f.size / 1024).toFixed(1);
        return { label: `${i + 1}. ${f.name.slice(0, 80)}`, value: `${f.msgId}:${f.attIndex}:${f.channelId}`, description: `${sizeStr} KB · ${f.author}` };
      });
      const menu = new StringSelectMenuBuilder().setCustomId('findcodes_select').setPlaceholder('Choisir un fichier à télécharger...').addOptions(grouped);
      const row = new ActionRowBuilder().addComponents(menu);
      const embed = new EmbedBuilder().setColor(mod.COLORS.source)
        .setTitle(`📎 "${rawQuery}" — ${allFiles.length} fichier(s) trouvé(s) dans #${channel.name}`)
        .setDescription(`Trop de fichiers (${allFiles.length}). Choisis un fichier ci-dessous pour le télécharger (25 plus récents affichés).`)
        .setFooter({ text: `${fetched} message(s) fouillé(s) · total: ${allFiles.length} fichier(s)` });
      await interaction.editReply({ embeds: [embed], components: [row] });
      return;
    }

    const lines = allFiles.map((f) => {
      const sizeStr = (f.size / 1024 / 1024 > 1) ? `${(f.size / 1024 / 1024).toFixed(2)} MB` : `${(f.size / 1024).toFixed(1)} KB`;
      return `**${f.name}** — ${sizeStr} · ${f.author} · <t:${Math.floor(f.createdAt / 1000)}:R>`;
    });
    const embed = new EmbedBuilder().setColor(mod.COLORS.source)
      .setTitle(`📎 "${rawQuery}" — ${allFiles.length} fichier(s) trouvé(s) dans #${channel.name}`)
      .setDescription(`Les fichiers ci-dessous sont prêts à être téléchargés. Clique sur le nom d'un fichier pour l'obtenir.\n\n${lines.join('\n').slice(0, 4000)}`)
      .setFooter({ text: `${fetched} message(s) fouillé(s)` });
    
    const buttons = allFiles.slice(0, 5).map((f) =>
      new ButtonBuilder().setCustomId(`findcodes_dl_${f.msgId}_${f.attIndex}_${f.channelId}`).setLabel(`📥 ${f.name.slice(0, 20)}`).setStyle(ButtonStyle.Primary)
    );
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) {
      rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    }
    
    await interaction.editReply({ embeds: [embed], components: rows });
    return;
  }
  if (cmd === 'help') {
    await interaction.editReply({ embeds: [buildHelpEmbed('mod', guild)], components: [buildHelpRow('mod')] });
    return;
  }
}

// ----------------------------------------------------------------
// COMMANDE OWNER : /diag
// ----------------------------------------------------------------
async function handleDiag(interaction) {
  await interaction.deferReply({ ephemeral: true });
  if (!isBotOwner(interaction.user.id)) { await interaction.editReply('❌ Réservé au propriétaire du bot.'); return; }
  const st = db.getStatus();
  const lines = [
    `🧩 Instance \`${INSTANCE_ID}\` · démarrée <t:${Math.floor(STARTED_AT / 1000)}:R>`,
    st.persistent ? '💾 Stockage : ✅ MongoDB connecté' : `💾 Stockage : ❌ NON persistant (${st.uriSet ? st.connectError : 'MONGODB_URI absent'})`,
    dup.count > 0 ? `🚨 Doublon détecté ${dup.count} fois (dernier : <t:${Math.floor(dup.lastAt / 1000)}:R>). Arrête l'autre copie (Termux : \`pkill node\`).` : '✅ Aucun doublon détecté.',
    `📡 Serveurs : ${client.guilds.cache.size} — ${[...client.guilds.cache.values()].map((g) => g.name).join(', ')}`,
  ];
  await interaction.editReply(lines.join('\n'));
}

// ----------------------------------------------------------------
// ROUTEUR D'INTERACTIONS
// ----------------------------------------------------------------
async function routeInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'diag') { await handleDiag(interaction); return; }
  if (!interaction.guildId) { await interaction.reply({ content: 'Utilise ça dans un serveur.', ephemeral: true }); return; }

  const guild = interaction.guild;
  const g = db.get(guild.id);

  if (interaction.commandName === 'deobf') {
    if (!mod.hasModPerms(interaction.member, g)) {
      await interaction.reply({ content: "❌ Tu n'as pas la permission d'utiliser `/deobf` (Administrateur, Gérer le serveur, ou un rôle autorisé via `/staffrole`).", ephemeral: true });
      return;
    }
    await interaction.deferReply();
    const file = interaction.options.getAttachment('fichier');
    if (file.size > 2_000_000) { await interaction.editReply('❌ Fichier trop volumineux (2 Mo max).'); return; }
    const fast = interaction.options.getBoolean('rapide');
    const result = await downloadAndDeobf(file.url, file.name, fast ? ['--no-devirt'] : []);
    if (!result.ok) {
      await interaction.editReply(`❌ Échec de la déobfuscation :\n\`\`\`\n${(result.error || '').slice(0, 1800)}\n\`\`\``);
    } else {
      await interaction.editReply({ content: '✅ Script déobfusqué :', files: [{ attachment: result.outPath, name: `deobf-${result.safeName.replace(/\.[^.]+$/, '')}.lua` }] });
    }
    fs.rm(result.tmpDir, { recursive: true, force: true }, () => {});
    return;
  }

  if (interaction.commandName === 'ask') {
    await interaction.deferReply();
    const question = interaction.options.getString('question');
    const canModerate = mod.hasModPerms(interaction.member, g);
    const res = await ai.askClaude({ channelId: interaction.channelId, userId: interaction.user.id, userName: interaction.user.username, userText: question, persona: g.aiPersona, serverContext: needsServerContext(question) ? buildServerContext(guild) : null, speakerInfo: buildSpeakerInfo(interaction.member), guild, canModerate, modExecutor: canModerate ? (args) => executeModAction({ guild, actorMember: interaction.member, ...args }) : null });
    await interaction.editReply(res.error ? `❌ ${res.error}` : res.text);
    return;
  }

  const nonStaffAllowed = new Set(['warnings', 'help']); // /warnings gère lui-même le cas "soi-même"
  if (!nonStaffAllowed.has(interaction.commandName) && !mod.hasModPerms(interaction.member, g)) {
    await interaction.reply({ content: "❌ Tu n'as pas la permission d'utiliser cette commande (Administrateur, Gérer le serveur, ou un rôle autorisé via `/staffrole`).", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: ['warnings', 'modlogs', 'case', 'staffrole', 'warnactions', 'automod', 'ai', 'help', 'setmodlog', 'vider'].includes(interaction.commandName) });
  await handleModCommand(interaction, guild, g);
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    await dbReadyPromise;
    if (interaction.isStringSelectMenu() || interaction.isButton()) { await routeSelect(interaction); return; }
    await routeInteraction(interaction);
  } catch (err) {
    if (err && err.code === 40060) { dup.count++; dup.lastAt = Date.now(); console.warn('🚨 Une autre copie du bot répond aussi (Termux + Render ?).'); return; }
    console.error('Erreur interaction :', err);
    if (interaction.isRepliable && interaction.isRepliable() && !interaction.replied && !interaction.deferred) await interaction.reply({ content: 'Une erreur est survenue.', ephemeral: true }).catch(() => {});
    else if (interaction.deferred) await interaction.editReply({ content: 'Une erreur est survenue.' }).catch(() => {});
  }
});

// ----------------------------------------------------------------
// AUTOMOD + CHAT IA SUR LES MESSAGES
// ----------------------------------------------------------------
client.on(Events.MessageCreate, async (message) => {
  try {
    await dbReadyPromise;
    if (!message.guild || message.author.bot) return;

    const handled = await automod.checkMessage(message);
    if (handled) return;

    const g = db.get(message.guild.id);
    const mentioned = message.mentions.has(client.user.id);
    const inAiChannel = g.aiChannels.includes(message.channelId);
    if (!inAiChannel && !(mentioned && g.aiEnabled)) return;

    // Fichier .lua/.luau/.txt joint : déobfuscation directe (vrai outil, pas
    // l'IA — plus fiable pour du bytecode VM obfusqué), staff uniquement.
    const luaAttachment = [...message.attachments.values()].find((a) => /\.(lua|luau|txt)$/i.test(a.name));
    if (luaAttachment) {
      if (!mod.hasModPerms(message.member, g)) {
        await message.reply({ content: "❌ Seul le staff peut utiliser la déobfuscation.", allowedMentions: { repliedUser: false } });
        return;
      }
      if (luaAttachment.size > 2_000_000) {
        await message.reply({ content: '❌ Fichier trop volumineux (2 Mo max).', allowedMentions: { repliedUser: false } });
        return;
      }
      await message.channel.sendTyping().catch(() => {});
      const result = await downloadAndDeobf(luaAttachment.url, luaAttachment.name);
      if (!result.ok) {
        await message.reply({ content: `❌ Échec de la déobfuscation :\n\`\`\`\n${(result.error || '').slice(0, 1800)}\n\`\`\``, allowedMentions: { repliedUser: false } });
      } else {
        await message.reply({ content: '✅ Script déobfusqué :', files: [{ attachment: result.outPath, name: `deobf-${result.safeName.replace(/\.[^.]+$/, '')}.lua` }], allowedMentions: { repliedUser: false } });
      }
      fs.rm(result.tmpDir, { recursive: true, force: true }, () => {});
      return;
    }

    const text = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
    if (!text) return;
    await message.channel.sendTyping().catch(() => {});
    const canModerate = mod.hasModPerms(message.member, g);
    const res = await ai.askClaude({ channelId: message.channelId, userId: message.author.id, userName: message.author.username, userText: text, persona: g.aiPersona, serverContext: needsServerContext(text) ? buildServerContext(message.guild) : null, speakerInfo: buildSpeakerInfo(message.member), guild: message.guild, canModerate, modExecutor: canModerate ? (args) => executeModAction({ guild: message.guild, actorMember: message.member, ...args }) : null });
    const out = res.error ? `❌ ${res.error}` : res.text;
    await message.reply({ content: out, allowedMentions: { repliedUser: false } });
  } catch (e) { console.error('Erreur MessageCreate :', e); }
});

client.on(Events.GuildMemberAdd, async (member) => {
  try { await dbReadyPromise; await automod.checkJoin(member); } catch (e) { console.error('Erreur GuildMemberAdd :', e); }
});

// ----------------------------------------------------------------
// DÉMARRAGE
// ----------------------------------------------------------------
// Le serveur web démarre EN PREMIER, avant toute connexion MongoDB : Render
// surveille son port pour savoir si l'app est vivante, et le tuerait pendant
// des tentatives MongoDB lentes/échouées sinon (redémarrages en boucle).
require('./server');
(async () => {
  await ensureDeobfExtracted();
  await ensureLuauBinary();
})();
if (!process.env.DISCORD_TOKEN) console.error("❌ DISCORD_TOKEN manquant : ajoute-le dans les variables d'environnement.");
client.login(process.env.DISCORD_TOKEN).catch((e) => console.error('❌ Connexion Discord impossible :', e.message));

if (process.env.PUBLIC_URL) {
  const https = require('https');
  setInterval(() => {
    https.get(`${process.env.PUBLIC_URL.replace(/\/$/, '')}/health`, (res) => res.resume()).on('error', () => {});
  }, 10 * 60 * 1000);
}
