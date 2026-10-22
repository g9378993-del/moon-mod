require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const db = require('./db');
const mod = require('./moderation');
// Toutes les couleurs des embeds du bot en rouge (on mute les valeurs de l'objet COLORS partagé avec moderation.js).
if (mod.COLORS) { for (const k of Object.keys(mod.COLORS)) mod.COLORS[k] = 0xFF0000; }
const automod = require('./automod');
const ai = require('./ai');
const economy = require('./economy');
const perms = require('./perms');
const constructionCmds = require('./construction_commands');
const trade = require('./trade');
const bf = require('./brainrot-finder');
const {
  Client, GatewayIntentBits, Partials, Events, PermissionFlagsBits, ChannelType,
  EmbedBuilder, REST, Routes, SlashCommandBuilder, AttachmentBuilder,
  ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
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
  if (!perms.hasStaff(actorMember, g)) return { error: "Tu n'as pas la permission d'effectuer des actions de modération." };
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
      dashboard.pushLog('mod', `<b>${targetMember.user.tag}</b> expulsé(e) — ${finalReason}`);
      return { success: true, message: `${targetMember.user.tag} expulsé(e). Cas #${c.id}.` };
    }
    if (action === 'ban') {
      await guild.members.ban(user_id, { reason: finalReason });
      const c = db.addCase(g, { type: 'ban', userId: user_id, moderatorId: actorMember.id, reason: finalReason });
      await db.save(guild.id);
      await mod.postToModLog(client, g, mod.caseEmbed(c, guild.name));
      dashboard.pushLog('mod', `Utilisateur <b>${user_id}</b> banni — ${finalReason}`);
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
      dashboard.pushLog('mod', `<b>${targetMember.user.tag}</b> en sourdine ${mod.fmtDuration(ms)} — ${finalReason}`);
      return { success: true, message: `${targetMember.user.tag} en sourdine pour ${mod.fmtDuration(ms)}. Cas #${c.id}.` };
    }
    if (action === 'warn') {
      if (!targetMember) return { error: "Cette personne n'est pas sur le serveur." };
      const c = db.addCase(g, { type: 'warn', userId: user_id, moderatorId: actorMember.id, reason: finalReason });
      const warnCount = g.cases.filter((x) => x.type === 'warn' && x.userId === user_id).length;
      await db.save(guild.id);
      await mod.postToModLog(client, g, mod.caseEmbed(c, guild.name));
      dashboard.pushLog('mod', `<b>${targetMember.user.tag}</b> averti(e) (${warnCount}/3+) — ${finalReason}`);
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
  if (!fs.existsSync(DEOBF_ENTRY)) return;
  if (fs.existsSync(luauPath)) { console.log('[deobf] Binaire luau déjà présent, pas de téléchargement.'); return; }
  console.log('[deobf] Binaire luau absent, téléchargement automatique...');

  // 0. `unzip` doit exister sur le serveur, sinon inutile d'aller plus loin.
  const hasUnzip = await new Promise((resolve) => {
    const p = spawn('unzip', ['-v']);
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
  if (!hasUnzip) { console.error("[deobf] ÉCHEC : la commande `unzip` n'existe pas sur ce serveur. Impossible d'extraire le binaire automatiquement."); return; }
  console.log('[deobf] `unzip` disponible ✅');

  try {
    fs.mkdirSync(binDir, { recursive: true });

    // Lien de téléchargement direct de GitHub (redirige toujours vers la
    // dernière release) : contrairement à api.github.com, ce lien n'est PAS
    // limité à 60 appels/heure par IP, donc pas de risque de quota cramé
    // après plusieurs redéploiements.
    const assetUrl = 'https://github.com/luau-lang/luau/releases/latest/download/luau-ubuntu.zip';
    console.log(`[deobf] Téléchargement : ${assetUrl}`);
    const dlRes = await fetch(assetUrl, { redirect: 'follow' });
    if (!dlRes.ok) { console.error(`[deobf] ÉCHEC : le téléchargement a renvoyé ${dlRes.status} (${dlRes.url}).`); return; }
    const buf = await dlRes.arrayBuffer();
    if (buf.byteLength < 10000) { console.error(`[deobf] ÉCHEC : réponse trop petite (${buf.byteLength} octets) — probablement une page d'erreur, pas le zip.`); return; }
    const zipPath = path.join(binDir, 'luau.zip');
    fs.writeFileSync(zipPath, Buffer.from(buf));
    console.log(`[deobf] Zip téléchargé (${buf.byteLength} octets) : ${zipPath}`);

    // 3. Extraire.
    const extractCode = await new Promise((resolve) => {
      const p = spawn('unzip', ['-o', zipPath, '-d', binDir]);
      let stderr = '';
      p.stderr.on('data', (d) => { stderr += d.toString(); });
      p.on('close', (code) => { if (stderr) console.log('[deobf] unzip stderr :', stderr.trim()); resolve(code); });
      p.on('error', (e) => { console.error('[deobf] ÉCHEC : impossible de lancer unzip :', e.message); resolve(1); });
    });
    fs.rm(zipPath, { force: true }, () => {});
    console.log(`[deobf] unzip terminé (code ${extractCode})`);

    // 4. Chercher le binaire "luau" où qu'il soit dans binDir (au cas où le
    // zip aurait un sous-dossier), et le mettre directement dans binDir/luau.
    const found = findFileRecursive(binDir, (name) => name === 'luau' || name === 'luau.exe');
    if (found && found !== luauPath) { fs.copyFileSync(found, luauPath); }
    if (fs.existsSync(luauPath)) {
      fs.chmodSync(luauPath, 0o755);
      const analyzePath = findFileRecursive(binDir, (name) => name === 'luau-ast' || name === 'luau-analyze');
      if (analyzePath) fs.chmodSync(analyzePath, 0o755);
      console.log('[deobf] Binaire luau installé ✅');
    } else {
      const listing = fs.readdirSync(binDir, { recursive: true }).join(', ');
      console.error(`[deobf] ÉCHEC : toujours pas de binaire "luau" après extraction. Contenu de bin/ : ${listing || '(vide)'}`);
    }
  } catch (e) {
    console.error('[deobf] Installation automatique du binaire luau impossible :', e.message);
  }
}

function findFileRecursive(dir, matchName) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { const r = findFileRecursive(full, matchName); if (r) return r; }
    else if (matchName(entry.name)) return full;
  }
  return null;
}

// ----------------------------------------------------------------
// DÉOBFUSCATEUR LUA/LUAU (indépendant de l'IA — lance deobf/deob.py en
// sous-processus Python). Dossier attendu : ./deobf/deob.py à la racine du
// projet (copié depuis le zip fourni). Nécessite python3 sur le serveur et
// un binaire luau (Linux) dans deobf/bin/luau — voir deobf/CLAUDE.md.
// ----------------------------------------------------------------
const DEOBF_DIR = path.join(__dirname, 'deobf');
const DEOBF_ENTRY = path.join(DEOBF_DIR, 'deob.py');
const DEOBF_TIMEOUT_SEC = 120;   // par exécution du tracer (Luraph v15 : une passe de dévirtualisation peut dépasser 80 s)
const DEOBF_TOTAL_SEC = 600;     // limite globale avant d'abandonner (l'interaction Discord tient 15 min)

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
    const args = [DEOBF_ENTRY, inputPath, '-o', outPath, '--timeout', String(DEOBF_TIMEOUT_SEC), ...extraArgs];
    let proc;
    try {
      proc = spawn('python3', args, { cwd: DEOBF_DIR });
    } catch (e) {
      resolve({ ok: false, error: `Impossible de lancer python3 : ${e.message}` });
      return;
    }
    let timedOut = false;
    const killer = setTimeout(() => { timedOut = true; try { proc.kill('SIGKILL'); } catch (e) { /* déjà terminé */ } }, DEOBF_TOTAL_SEC * 1000);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => { clearTimeout(killer); resolve({ ok: false, error: `python3 introuvable ou erreur de lancement : ${e.message}` }); });
    proc.on('close', (code) => {
      clearTimeout(killer);
      if (code === 0 && fs.existsSync(outPath)) { resolve({ ok: true, outPath, log: stderr }); return; }
      // L'outil écrit déjà un résultat intermédiaire avant la dévirtualisation :
      // mieux vaut le renvoyer (marqué partiel) qu'un simple échec.
      if (fs.existsSync(outPath)) { resolve({ ok: true, partial: true, outPath }); return; }
      const tail = stderr.trim().split('\n').filter(Boolean).slice(-8).join('\n');
      const reason = timedOut ? `Temps maximum dépassé (${DEOBF_TOTAL_SEC}s).` : `Échec (code de sortie ${code}).`;
      resolve({ ok: false, error: tail ? `${reason}\n${tail}` : reason });
    });
  });
}

// Message de résultat : évite de dire "✅" quand le script a planté dès le
// début de la trace (résultat vide) ou que le temps a été dépassé.
function deobfMessage(result) {
  if (result.partial) return '⚠️ Résultat partiel (temps dépassé avant la fin de la dévirtualisation) :';
  try {
    const head = fs.readFileSync(result.outPath, 'utf8').slice(0, 3000);
    const status = head.match(/^-- run status: (.+)$/m);
    const count = head.match(/-- (\d+) statements recorded/);
    if (status && count && Number(count[1]) <= 1) {
      return `⚠️ Résultat vide : le script a planté dès le début de l'exécution simulée (${status[1].slice(0, 200)}). Il dépend sûrement de variables/fonctions absentes de l'environnement simulé, ou d'un morceau de code manquant.`;
    }
  } catch (e) { /* message standard */ }
  try {
    const head = fs.readFileSync(result.outPath, 'utf8').slice(0, 200);
    if (head.startsWith('-- Deobfuscated by deobf (dynamic trace)')) {
      const warns = (result.log || '').split('\n').filter((l) => l.startsWith('[!]')).slice(0, 2).join(' ').slice(0, 400);
      return `⚠️ Trace de comportement seulement (pas le code complet)${warns ? ` — ${warns}` : ''} :`;
    }
  } catch (e) { /* message standard */ }
  return '✅ Script déobfusqué :';
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
    GatewayIntentBits.GuildVoiceStates, // nécessaire pour le gain de pièces en vocal
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
      .addStringOption((o) => o.setName('etat').setDescription('on/off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })))
    .addSubcommand((s) => s.setName('antialts').setDescription('Bloquer les nouveaux comptes (alts) de rejoindre le serveur')
      .addStringOption((o) => o.setName('etat').setDescription('on/off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }))
      .addIntegerOption((o) => o.setName('age_min_jours').setDescription('Âge minimum du compte en jours (défaut 7)').setMinValue(0).setMaxValue(365))
      .addStringOption((o) => o.setName('action').setDescription('Action (kick ou timeout 24h)').addChoices({ name: 'kick', value: 'kick' }, { name: 'timeout 24h', value: 'timeout' }))),

  new SlashCommandBuilder().setName('scanalts').setDescription('Trouver les comptes récents (alts probables) déjà sur le serveur, et agir dessus')
    .addIntegerOption((o) => o.setName('age_min_jours').setDescription('Compte créé il y a moins de X jours = suspect (défaut : réglage /automod antialts, sinon 7)').setMinValue(0).setMaxValue(365)),

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
  new SlashCommandBuilder().setName('aichat')
    .setDescription('(Admin) Configurer le salon IA public')
    .addSubcommand((s) => s.setName('setup').setDescription('Définir le salon IA public')
      .addChannelOption((o) => o.setName('salon').setDescription('Salon où tout le monde peut parler à l\'IA').setRequired(true))
      .addStringOption((o) => o.setName('personnalite').setDescription('Personnalité de l\'IA (optionnel)').setMaxLength(200)))
    .addSubcommand((s) => s.setName('disable').setDescription('Désactiver le salon IA public'))
    .addSubcommand((s) => s.setName('info').setDescription('Voir la configuration du salon IA')),
].map((c) => c.setDMPermission(false).toJSON());

commands.push(...economy.commands, ...perms.commands, ...constructionCmds.commands, ...trade.commands, ...bf.commands);
perms.setCommandNames(commands.map((c) => c.name));


const ownerCommands = [
  new SlashCommandBuilder().setName('diag').setDescription('(Toi uniquement) État du bot : stockage, doublons, serveurs'),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const body = [...commands, ...ownerCommands];
  console.log(`📦 Total commandes a enregistrer: ${body.length} (${commands.length} + ${ownerCommands.length})`);
  console.log(`   Commandes BF: ${body.filter(c => c.name && c.name.startsWith('brainrot')).length}`);
  console.log(`   Noms: ${body.map(c => c.name).join(', ')}`);

  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [] });
    console.log('✓ Anciennes commandes globales supprimees.');
  } catch (err) { console.error('❌ Erreur suppression commandes globales:', err.message); }

  for (const guild of client.guilds.cache.values()) {
    try {
      await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, guild.id), { body });
      console.log(`✓ ${body.length} commandes enregistrees sur ${guild.name}`);
    } catch (err) {
      console.error(`❌ Erreur sur ${guild.name}:`, err.message);
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
      '`/staffrole` `/permuser` — choisir qui (rôle / membre) peut utiliser quelles commandes (vide = toutes).',
      '`/warnactions` — sanctions auto selon le nb d\'avertissements',
    ].join('\n'),
  },
  automod: {
    label: '🛡️ Automod',
    text: [
      '`/automod antilien/antispam/antimention/motsinterdits/grosmots/antiraid`',
      '`/automod salonstrict` — mode "modérateur strict" dans un salon choisi : bloque tout lien et fichier, spam et raid supprimés automatiquement.',
      "`/automod antialts` — bloque les comptes trop récents à l'arrivée.",
      '`/scanalts [age_min_jours]` — cherche les comptes trop récents déjà présents sur le serveur, et propose Kick/Timeout/Ban/Annuler par bouton pour chacun.',
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
  eco: {
    label: '💰 Économie',
    text: [
      '`/panelcoins` — poste le panel (Coins, Messages, Voice Time, Leaderboard, Shop, Transfer...).',
      '`/ecoconfig messages` `vocal` `off` — règles de gain (salon, nombre, pièces, limite par jour).',
      '`/ecoconfig panel` `fuseau` `logs` `voir` — textes du panel, reset quotidien, logs, config.',
      '`/ecoadmin add` `remove` `set` `reset` — modifier les pièces d\'un membre.',
      '`/shop add` `edit` `remove` `list` — gérer le shop (rôle auto, stock...).',
      '`/coins` — voir son solde.',
    ].join('\n'),
  },
  trade: {
    label: '🔄 Échange brainrots',
    text: [
      '`/tradeconfig panel [salon]` — (staff) poste le panel avec le bouton "Create Trade", pour que les membres (sans accès aux commandes) puissent poster une annonce.',
      '`/brainrot post photo:… nom:… [veux] [description]` — poste ton brainrot avec un bouton "Trade" (alternative pour le staff).',
      'Un membre ne peut avoir qu\'UNE annonce active : il doit la retirer (bouton "Retirer") avant d\'en reposter une.',
      'Quand quelqu\'un clique "Trade", il décrit son offre → tu la reçois en DM avec Accepter/Refuser.',
      '`/brainrot mine` — voir tes annonces. `/brainrot remove` — en retirer une.',
      '`/tradeconfig salon` `voir` — (staff) restreindre les annonces à un salon précis.',
    ].join('\n'),
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

  if (interaction.customId.startsWith('findcodes_select')) {
    const value = interaction.values[0];
    const [msgId, attIndexStr, channelId] = value.split(':');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const targetChannel = interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null);
      if (!targetChannel) { await interaction.editReply(`❌ Salon introuvable (peut-être supprimé).`); return; }
      const msg = await targetChannel.messages.fetch(msgId);
      const att = [...msg.attachments.values()][parseInt(attIndexStr, 10)];
      if (!att) { await interaction.editReply(`❌ Fichier introuvable dans le message.`); return; }
      const fileData = Buffer.from(await (await fetch(att.url)).arrayBuffer());
      const attachment = new AttachmentBuilder(fileData, { name: att.name });
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const targetChannel = interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null);
      if (!targetChannel) { await interaction.editReply(`❌ Salon introuvable (peut-être supprimé).`); return; }
      const msg = await targetChannel.messages.fetch(msgId);
      const att = [...msg.attachments.values()][attIndex];
      if (!att) { await interaction.editReply(`❌ Fichier introuvable.`); return; }
      const fileData = Buffer.from(await (await fetch(att.url)).arrayBuffer());
      if (fileData.length > 25 * 1024 * 1024) { await interaction.editReply(`❌ Fichier trop volumineux (${(fileData.length / 1024 / 1024).toFixed(1)} MB, max 25 MB).`); return; }
      const attachment = new AttachmentBuilder(fileData, { name: att.name });
      await interaction.editReply({ content: `📥 **${att.name}** (${(att.size / 1024).toFixed(1)} KB)`, files: [attachment] });
    } catch (e) {
      await interaction.editReply(`❌ Erreur (${e.message}).`);
    }
    return;
  }

  if (interaction.customId.startsWith('scanalts_select_')) {
    const g = db.get(interaction.guild.id);
    if (!perms.canUseCommand(interaction.member, g, 'scanalts')) { await interaction.reply({ flags: MessageFlags.Ephemeral, content: "❌ Tu n'as pas la permission d'utiliser `/scanalts`."}); return; }
    const userId = interaction.values[0];
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const target = await interaction.guild.members.fetch(userId).catch(() => null);
    if (!target) { await interaction.editReply('❌ Ce membre a quitté le serveur entre-temps.'); return; }
    const ageDays = Math.floor((Date.now() - target.user.createdTimestamp) / 86400000);
    const embed = new EmbedBuilder().setColor(mod.COLORS.source)
      .setTitle(`🕵️ ${target.user.tag}`)
      .setDescription(`Compte créé il y a **${ageDays} jour(s)** (<t:${Math.floor(target.user.createdTimestamp / 1000)}:D>)\nA rejoint le serveur <t:${Math.floor(target.joinedTimestamp / 1000)}:R>.\n\nQue veux-tu faire ?`);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`scanalts_act_kick_${userId}`).setLabel('Kick').setEmoji('👢').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`scanalts_act_timeout_${userId}`).setLabel('Timeout 24h').setEmoji('🔇').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`scanalts_act_ban_${userId}`).setLabel('Ban').setEmoji('🔨').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`scanalts_act_cancel_${userId}`).setLabel('Annuler').setEmoji('✖️').setStyle(ButtonStyle.Secondary),
    );
    await interaction.editReply({ embeds: [embed], components: [row] });
    return;
  }

  if (interaction.customId.startsWith('scanalts_act_')) {
    const rest = interaction.customId.slice('scanalts_act_'.length);
    const sep = rest.indexOf('_');
    const action = rest.slice(0, sep);
    const userId = rest.slice(sep + 1);
    if (action === 'cancel') { await interaction.update({ content: '✖️ Annulé, aucune action effectuée.', embeds: [], components: [] }); return; }
    await interaction.deferUpdate();
    const res = await executeModAction({ guild: interaction.guild, actorMember: interaction.member, action, user_id: userId, reason: 'Compte suspecté alt (scan /scanalts)', duration: action === 'timeout' ? '24h' : undefined });
    await interaction.editReply({ content: res.error ? `❌ ${res.error}` : `✅ ${res.message}`, embeds: [], components: [] });
    return;
  }

  // Menu de sélection des salons à supprimer (construction commands)
  if (constructionCmds.isDeleteSelectMenu && constructionCmds.isDeleteSelectMenu(interaction.customId)) {
    const g = db.get(interaction.guild.id);
    await constructionCmds.handleSelectMenu(interaction, client, g, db);
    return;
  }

  // Confirmation de suppression de salon(s) (construction commands)
  if (interaction.customId.startsWith('delete_confirm_')) {
    // customId = delete_confirm_<token> — IDs récupérés depuis la map en mémoire
    const token = interaction.customId.slice('delete_confirm_'.length);
    const ids = constructionCmds.popPending ? constructionCmds.popPending(token) : null;
    if (!ids || ids.length === 0) {
      await interaction.update({ content: '❌ Session expirée, relance `/deletechannel`.', embeds: [], components: [] });
      return;
    }
    let deleted = 0, failed = 0;
    for (const channelId of ids) {
      const channel = interaction.guild.channels.cache.get(channelId);
      if (channel && channel.deletable) {
        await channel.delete('Suppression confirmée par ' + interaction.user.tag).catch(() => { failed++; return; });
        deleted++;
      } else {
        failed++;
      }
    }
    const msg = deleted > 0
      ? `✅ ${deleted} salon(s) supprimé(s).` + (failed > 0 ? ` ⚠️ ${failed} échec(s).` : '')
      : `❌ Impossible de supprimer les salons.`;
    await interaction.update({ content: msg, embeds: [], components: [] });
    return;
  }
  if (interaction.customId.startsWith('delete_cancel_')) {
    await interaction.update({ content: '❌ Suppression annulée.', embeds: [], components: [] });
    return;
  }
}



// ----------------------------------------------------------------
// DÉMARRAGE / SUIVI DE VIE
// ----------------------------------------------------------------
client.once(Events.ClientReady, async () => {
  console.log(`Connecté en tant que ${client.user.tag} (instance ${INSTANCE_ID})`);
  dashboard.setClient(client);
  dashboard.setDb(db);
  dashboard.pushLog('sys', `Bot connecté en tant que <b>${client.user.tag}</b> — ${client.guilds.cache.size} serveur(s)`);
  await dbReadyPromise;
  console.log(`Serveurs actuels (${client.guilds.cache.size}) :`, [...client.guilds.cache.values()].map((g) => `${g.name} (${g.id})`).join(' | '));
  await registerCommands();
  economy.startVoiceTracking(client);
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
    if (cmd === 'warnings' && target.id !== interaction.user.id && !perms.hasStaff(interaction.member, g)) {
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
    if (sub === 'antialts') {
      am.antialts = am.antialts || { enabled: false, minAccountAgeDays: 7, action: 'kick' };
      const on = interaction.options.getString('etat') === 'on';
      if (on) {
        am.antialts.enabled = true;
        if (interaction.options.getInteger('age_min_jours') !== null) am.antialts.minAccountAgeDays = interaction.options.getInteger('age_min_jours');
        if (interaction.options.getString('action')) am.antialts.action = interaction.options.getString('action');
      } else {
        am.antialts.enabled = false;
      }
      await db.save(guild.id);
      await reply(`✅ Anti-alts : ${am.antialts.enabled ? `activé (âge min: ${am.antialts.minAccountAgeDays}j, action: ${am.antialts.action})` : 'désactivé'}.`);
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

  if (cmd === 'aichat') {
    if (!perms.canUseCommand(interaction.member, g, 'aichat')) { await reply('❌ Réservé au staff.'); return; }
    const sub = interaction.options.getSubcommand();
    if (sub === 'setup') {
      const channel = interaction.options.getChannel('salon');
      const personnalite = interaction.options.getString('personnalite') || null;
      if (!g.aiChat) g.aiChat = {};
      g.aiChat.channelId = channel.id;
      g.aiChat.persona = personnalite;
      g.aiChat.locked = false;
      await db.save(guild.id);
      // S'assurer que le salon est déverrouillé
      try {
        await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null });
      } catch {}
      await reply(`✅ Salon IA public configuré : ${channel}${personnalite ? `\nPersonnalité : *${personnalite}*` : ''}\nTout le monde peut y parler à l'IA. Le salon se verrouille automatiquement si le quota IA est épuisé.`);
      return;
    }
    if (sub === 'disable') {
      if (g.aiChat?.channelId) {
        const ch = guild.channels.cache.get(g.aiChat.channelId);
        if (ch) { try { await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null }); } catch {} }
      }
      g.aiChat = {};
      await db.save(guild.id);
      await reply('✅ Salon IA public désactivé.');
      return;
    }
    if (sub === 'info') {
      if (!g.aiChat?.channelId) { await reply('ℹ️ Aucun salon IA public configuré. Utilise `/aichat setup`.'); return; }
      const status = g.aiChat.locked ? '🔒 Verrouillé (quota épuisé)' : '🟢 Actif';
      await reply(`📋 Salon IA public : <#${g.aiChat.channelId}>\nStatut : ${status}\nPersonnalité : ${g.aiChat.persona || 'par défaut'}`);
      return;
    }
  }

  if (cmd === 'scanalts') {
    const am = g.automod;
    const minDays = interaction.options.getInteger('age_min_jours') ?? am.antialts?.minAccountAgeDays ?? 7;
    const threshold = Date.now() - minDays * 24 * 60 * 60 * 1000;

    await reply('🔍 Analyse des membres en cours...');
    try {
      const members = await guild.members.fetch();
      const suspects = members.filter((m) => !m.user.bot && m.user.createdTimestamp > threshold)
        .map((m) => m).sort((a, b) => b.user.createdTimestamp - a.user.createdTimestamp);

      if (!suspects.length) { await interaction.editReply(`✅ Aucun compte créé il y a moins de **${minDays}** jour(s) trouvé parmi les ${members.size} membres.`); return; }

      const fmtAge = (ts) => { const d = Math.floor((Date.now() - ts) / 86400000); return d < 1 ? "< 1 jour" : `${d} jour(s)`; };
      const MAX_SELECTABLE = 125; // 5 menus de 25 = limite Discord par message
      const selectable = suspects.slice(0, MAX_SELECTABLE);
      const rows = [];
      for (let from = 0; from < selectable.length; from += 25) {
        const chunk = selectable.slice(from, from + 25);
        const menu = new StringSelectMenuBuilder()
          .setCustomId(`scanalts_select_${rows.length}`)
          .setPlaceholder(`Comptes ${from + 1} à ${from + chunk.length} sur ${suspects.length}...`)
          .addOptions(chunk.map((m) => ({
            label: m.user.tag.slice(0, 100),
            value: m.id,
            description: `Compte créé il y a ${fmtAge(m.user.createdTimestamp)} · a rejoint il y a ${fmtAge(m.joinedTimestamp)}`.slice(0, 100),
          })));
        rows.push(new ActionRowBuilder().addComponents(menu));
      }
      const lines = selectable.slice(0, 15).map((m) => `<@${m.id}> — créé il y a **${fmtAge(m.user.createdTimestamp)}**`);
      const embed = new EmbedBuilder().setColor(mod.COLORS.source)
        .setTitle(`🕵️ ${suspects.length} compte(s) suspect(s) (< ${minDays}j)`)
        .setDescription(`${lines.join('\n')}${suspects.length > 15 ? `\n… et ${suspects.length - 15} autre(s).` : ''}\n\nChoisis un compte dans ${rows.length > 1 ? 'les menus' : 'le menu'} ci-dessous pour décider quoi en faire.${suspects.length > MAX_SELECTABLE ? `\n⚠️ Limite Discord : seuls les ${MAX_SELECTABLE} plus récents sont sélectionnables.` : ''}`)
        .setFooter({ text: `${members.size} membre(s) analysé(s)` });
      await interaction.editReply({ content: '', embeds: [embed], components: rows });
    } catch (err) {
      console.error('Erreur /scanalts :', err);
      await interaction.editReply(`❌ Erreur pendant l'analyse : ${err.message || err}.`).catch(() => {});
    }
    return;
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
      await interaction.followUp({ flags: MessageFlags.Ephemeral, content: `❌ Erreur pendant le vidage (${e.message}).`}).catch(() => {});
    }
    return;
  }

  if (cmd === 'findcodes') {
    const channel = interaction.options.getChannel('salon');
    const rawQuery = interaction.options.getString('recherche');
    const limite = interaction.options.getInteger('limite') || 10000;  // très haut pour fouiller le salon entier

    // Deux salons entrent en jeu : celui qu'on fouille (perms de LECTURE) et
    // celui où la commande est tapée, c'est-à-dire là où le bot doit
    // RÉPONDRE (perms d'ÉCRITURE : embeds + menus). Sans ça, Discord
    // affiche sa propre carte générique "Permissions manquantes" au lieu
    // d'un message clair — ce n'est PAS lié à /permuser ou /staffrole, qui
    // ne gèrent que le droit d'utiliser la commande, pas les permissions du
    // bot dans le salon Discord lui-même.
    const readPerms = channel.permissionsFor(botMember);
    if (!readPerms?.has(PermissionFlagsBits.ViewChannel) || !readPerms?.has(PermissionFlagsBits.ReadMessageHistory)) {
      await reply(`❌ Je n'ai pas la permission de lire l'historique de ${channel} (il me faut **Voir le salon** + **Lire l'historique des messages** là-bas).`);
      return;
    }
    const writePerms = interaction.channel?.permissionsFor(botMember);
    if (!writePerms?.has(PermissionFlagsBits.EmbedLinks)) {
      await reply(`❌ Il me manque la permission **Intégrer des liens** dans ${interaction.channel} pour répondre ici (rôle du bot → Permissions du salon).`);
      return;
    }

    await reply(`🔍 Fouille du salon entier en cours...`);

    try {
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

      // Un menu Discord = 25 options max, un message = 5 lignes max -> 125 fichiers
      // sélectionnables. Au-delà, la liste complète est jointe en fichier texte.
      const MAX_SELECTABLE = 125;
      const selectable = allFiles.slice(0, MAX_SELECTABLE);
      const fmtSize = (n) => (n / 1024 / 1024 > 1 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`);
      const rows = [];
      for (let from = 0; from < selectable.length; from += 25) {
        const chunk = selectable.slice(from, from + 25);
        const options = chunk.map((f, j) => ({
          label: `${from + j + 1}. ${f.name}`.slice(0, 100),
          value: `${f.msgId}:${f.attIndex}:${f.channelId}`,
          description: `${fmtSize(f.size)} · ${f.author}`.slice(0, 100),
        }));
        const menu = new StringSelectMenuBuilder()
          .setCustomId(`findcodes_select_${rows.length}`)
          .setPlaceholder(`Fichiers ${from + 1} à ${from + chunk.length} sur ${allFiles.length}...`)
          .addOptions(options);
        rows.push(new ActionRowBuilder().addComponents(menu));
      }

      const tooMany = allFiles.length > MAX_SELECTABLE;
      const embed = new EmbedBuilder().setColor(mod.COLORS.source)
        .setTitle(`📎 \"${rawQuery}\" — ${allFiles.length} fichier(s) trouvé(s) dans #${channel.name}`)
        .setDescription(`Choisis un fichier dans ${rows.length > 1 ? 'les menus' : 'le menu'} ci-dessous pour le télécharger (du plus récent au plus ancien).${tooMany ? `\nLimite Discord : seuls les ${MAX_SELECTABLE} plus récents sont dans les menus, la liste complète est dans le fichier joint.` : ''}`)
        .setFooter({ text: `${fetched} message(s) fouillé(s) · total: ${allFiles.length} fichier(s)` });
      const payload = { embeds: [embed], components: rows };
      if (tooMany) {
        if (!writePerms?.has(PermissionFlagsBits.AttachFiles)) {
          await interaction.editReply({ embeds: [embed], components: rows, content: `⚠️ Il me manque la permission **Joindre des fichiers** ici, donc la liste complète (au-delà de ${MAX_SELECTABLE}) n'a pas pu être jointe.` });
          return;
        }
        const listing = allFiles.map((f, i) => `${i + 1}. ${f.name} — ${fmtSize(f.size)} — ${f.author} — ${new Date(f.createdAt).toISOString()} — ${f.msgUrl}`).join('\n');
        payload.files = [new AttachmentBuilder(Buffer.from(listing, 'utf8'), { name: 'findcodes-liste-complete.txt' })];
      }
      await interaction.editReply(payload);
    } catch (err) {
      // On évite que Discord affiche sa carte générique "Permissions manquantes"
      // (souvent trompeuse) : ici, on donne le vrai message d'erreur.
      console.error('Erreur /findcodes :', err);
      await interaction.editReply(`❌ Erreur pendant la recherche : ${err.message || err}${err.code ? ` (code ${err.code})` : ''}.`).catch(() => {});
    }
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
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
  if (!interaction.guildId) { await interaction.reply({ flags: MessageFlags.Ephemeral, content: 'Utilise ça dans un serveur.'}); return; }

  const guild = interaction.guild;
  const g = db.get(guild.id);

  if (perms.isPermCommand(interaction.commandName)) { await perms.handleCommand(interaction); return; }

  if (interaction.commandName === 'deobf') {
    if (!perms.canUseCommand(interaction.member, g, 'deobf')) {
      await interaction.reply({ flags: MessageFlags.Ephemeral, content: "❌ Tu n'as pas la permission d'utiliser `/deobf` (Administrateur, Gérer le serveur, ou un rôle autorisé via `/staffrole`)."});
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
      await interaction.editReply({ content: deobfMessage(result), files: [{ attachment: result.outPath, name: `deobf-${result.safeName.replace(/\.[^.]+$/, '')}.lua` }] });
    }
    fs.rm(result.tmpDir, { recursive: true, force: true }, () => {});
    return;
  }

  if (bf.isBFCommand(interaction.commandName)) { await bf.handleCommand(interaction); return; }
  if (economy.isEconomyCommand(interaction.commandName)) { await economy.handleCommand(interaction); return; }
  if (trade.isTradeCommand(interaction.commandName)) { await trade.handleCommand(interaction); return; }

  if (constructionCmds.isConstructionCommand(interaction.commandName)) {
    if (!perms.canUseCommand(interaction.member, g, interaction.commandName)) {
      await interaction.reply({ flags: MessageFlags.Ephemeral, content: "❌ Tu n'as pas la permission d'utiliser cette commande (Administrateur, Gérer le serveur, ou un rôle autorisé via `/staffrole`)."});
      return;
    }
    await interaction.deferReply({ flags: ['buildmode', 'copychannels'].includes(interaction.commandName) ? MessageFlags.Ephemeral : undefined });
    await constructionCmds.handleCommand(interaction, client, g, db);
    return;
  }

  if (interaction.commandName === 'ask') {
    await interaction.deferReply();
    const question = interaction.options.getString('question');
    const canModerate = perms.hasStaff(interaction.member, g);
    const res = await ai.askClaude({ channelId: interaction.channelId, userId: interaction.user.id, userName: interaction.user.username, userText: question, persona: g.aiPersona, serverContext: needsServerContext(question) ? buildServerContext(guild) : null, speakerInfo: buildSpeakerInfo(interaction.member), guild, canModerate, modExecutor: canModerate ? (args) => executeModAction({ guild, actorMember: interaction.member, ...args }) : null });
    await interaction.editReply(res.error ? `❌ ${res.error}` : res.text);
    return;
  }

  const nonStaffAllowed = new Set(['warnings', 'help']); // /warnings gère lui-même le cas "soi-même"
  if (!nonStaffAllowed.has(interaction.commandName) && !perms.canUseCommand(interaction.member, g, interaction.commandName)) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "❌ Tu n'as pas la permission d'utiliser cette commande (Administrateur, Gérer le serveur, ou un rôle autorisé via `/staffrole`)."});
    return;
  }

  await interaction.deferReply({ flags: ['warnings', 'modlogs', 'case', 'staffrole', 'warnactions', 'automod', 'ai', 'help', 'setmodlog', 'vider', 'scanalts'].includes(interaction.commandName) ? MessageFlags.Ephemeral : undefined });
  await handleModCommand(interaction, guild, g);
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) { if (perms.isPermCommand(interaction.commandName)) await perms.autocomplete(interaction); else if (trade.isTradeCommand(interaction.commandName)) await trade.autocomplete(interaction); else if (bf.isBFCommand(interaction.commandName)) await bf.autocomplete(interaction); else await economy.autocomplete(interaction); return; }
    if (interaction.customId && interaction.customId.startsWith('eco:')) { await economy.handleComponent(interaction); return; }
    if (interaction.customId && interaction.customId.startsWith('trade:')) { await trade.handleComponent(interaction); return; }
    if (interaction.customId && interaction.customId.startsWith('bf:')) { await bf.handleComponent(interaction); return; }
    if (interaction.isStringSelectMenu() || interaction.isButton()) { await routeSelect(interaction); return; }
    await routeInteraction(interaction);
  } catch (err) {
    if (err && err.code === 40060) { dup.count++; dup.lastAt = Date.now(); console.warn('🚨 Une autre copie du bot répond aussi (Termux + Render ?).'); return; }
    console.error('Erreur interaction :', err);
    if (interaction.isRepliable && interaction.isRepliable() && !interaction.replied && !interaction.deferred) await interaction.reply({ flags: MessageFlags.Ephemeral, content: 'Une erreur est survenue.'}).catch(() => {});
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

    economy.onMessage(message); // gain de pièces (salon choisi via /ecoconfig messages)

    const g = db.get(message.guild.id);
    const mentioned = message.mentions.has(client.user.id);
    const inAiChannel = g.aiChannels.includes(message.channelId);
    const inAiChat = g.aiChat?.channelId === message.channelId;
    if (!inAiChannel && !inAiChat && !(mentioned && g.aiEnabled)) return;

    // Fichier .lua/.luau/.txt joint : déobfuscation directe (vrai outil, pas
    // l'IA — plus fiable pour du bytecode VM obfusqué), staff uniquement.
    const luaAttachment = [...message.attachments.values()].find((a) => /\.(lua|luau|txt)$/i.test(a.name));
    if (luaAttachment) {
      if (!perms.hasStaff(message.member, g)) {
        await message.reply({ flags: MessageFlags.Ephemeral, content: "❌ Seul le staff peut utiliser la déobfuscation.", allowedMentions: { repliedUser: false } });
        return;
      }
      if (luaAttachment.size > 2_000_000) {
        await message.reply({ flags: MessageFlags.Ephemeral, content: '❌ Fichier trop volumineux (2 Mo max).', allowedMentions: { repliedUser: false } });
        return;
      }
      await message.channel.sendTyping().catch(() => {});
      const typingTimer = setInterval(() => { message.channel.sendTyping().catch(() => {}); }, 8000);
      let result;
      try { result = await downloadAndDeobf(luaAttachment.url, luaAttachment.name); } finally { clearInterval(typingTimer); }
      if (!result.ok) {
        await message.reply({ flags: MessageFlags.Ephemeral, content: `❌ Échec de la déobfuscation :\n\`\`\`\n${(result.error || '').slice(0, 1800)}\n\`\`\``, allowedMentions: { repliedUser: false } });
      } else {
        await message.reply({ flags: MessageFlags.Ephemeral, content: deobfMessage(result), files: [{ attachment: result.outPath, name: `deobf-${result.safeName.replace(/\.[^.]+$/, '')}.lua` }], allowedMentions: { repliedUser: false } });
      }
      fs.rm(result.tmpDir, { recursive: true, force: true }, () => {});
      return;
    }

    const text = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
    if (!text) return;
    await message.channel.sendTyping().catch(() => {});
    const canModerate = perms.hasStaff(message.member, g);
    const persona = inAiChat ? (g.aiChat?.persona || g.aiPersona) : g.aiPersona;
    const res = await ai.askClaude({ channelId: message.channelId, userId: message.author.id, userName: message.author.username, userText: text, persona, serverContext: needsServerContext(text) ? buildServerContext(message.guild) : null, speakerInfo: buildSpeakerInfo(message.member), guild: message.guild, canModerate, modExecutor: canModerate ? (args) => executeModAction({ guild: message.guild, actorMember: message.member, ...args }) : null });

    // AI Chat public : réponse publique + gestion quota lock/unlock
    if (inAiChat) {
      if (res.quotaExhausted && !g.aiChat.locked) {
        // Quota épuisé → verrouiller le salon
        g.aiChat.locked = true;
        await db.save(message.guild.id);
        try {
          await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false });
          await message.channel.send('🔒 **Salon temporairement verrouillé** — Le quota IA journalier est épuisé. Le salon se déverrouillera automatiquement dès que l\'IA sera à nouveau disponible.');
        } catch {}
        return;
      }
      if (!res.error) {
        // Succès → déverrouiller si nécessaire
        if (g.aiChat.locked) {
          g.aiChat.locked = false;
          await db.save(message.guild.id);
          try {
            await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: null });
            await message.channel.send('🔓 **Salon déverrouillé** — L\'IA est à nouveau disponible !');
          } catch {}
        }
        await message.reply({ content: res.text, allowedMentions: { repliedUser: true } });
      }
      dashboard.recordAiExchange({ blocked: !!res.error });
      dashboard.pushLog('ai', `[AI Chat] Réponse à <b>${message.author.username}</b> dans <b>#${message.channel.name}</b>`);
      return;
    }

    const out = res.error ? `❌ ${res.error}` : res.text;
    dashboard.recordAiExchange({ blocked: !!res.error });
    dashboard.pushLog('ai', `Réponse à <b>${message.author.username}</b> dans <b>#${message.channel.name}</b>`);
    await message.reply({ flags: MessageFlags.Ephemeral, content: out, allowedMentions: { repliedUser: false } });
  } catch (e) { console.error('Erreur MessageCreate :', e); }
});

// Retry toutes les 10 minutes pour déverrouiller les salons IA si quota restauré
setInterval(async () => {
  for (const [guildId, g] of Object.entries(db.peek())) {
    if (!g.aiChat?.channelId || !g.aiChat?.locked) continue;
    try {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;
      const channel = guild.channels.cache.get(g.aiChat.channelId);
      if (!channel) continue;
      const res = await ai.askClaude({ channelId: g.aiChat.channelId, userId: 'system', userName: 'system', userText: 'test', persona: g.aiChat.persona || null, guild, canModerate: false, modExecutor: null });
      if (!res.error) {
        g.aiChat.locked = false;
        await db.save(guildId);
        await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null }).catch(() => {});
        await channel.send('🔓 **Salon déverrouillé** — L\'IA est à nouveau disponible !').catch(() => {});
      }
    } catch {}
  }
}, 10 * 60 * 1000);

client.on(Events.GuildMemberAdd, async (member) => {
  try { 
    await dbReadyPromise; 
    await automod.checkJoin(member);
    await automod.checkAntialts(member);
  } catch (e) { console.error('Erreur GuildMemberAdd :', e); }
});

// ----------------------------------------------------------------
// DÉMARRAGE
// ----------------------------------------------------------------
// Le serveur web démarre EN PREMIER, avant toute connexion MongoDB : Render
// surveille son port pour savoir si l'app est vivante, et le tuerait pendant
// des tentatives MongoDB lentes/échouées sinon (redémarrages en boucle).
const dashboard = require('./server');
(async () => {
  await ensureDeobfExtracted();
  await ensureLuauBinary();
  if (!process.env.DISCORD_TOKEN) console.error("❌ DISCORD_TOKEN manquant : ajoute-le dans les variables d'environnement.");
  client.login(process.env.DISCORD_TOKEN).catch((e) => console.error('❌ Connexion Discord impossible :', e.message));
})();

const http = require('http');
http.createServer((req, res) => res.end('OK')).listen(process.env.SERVER_PORT || process.env.PORT || 3000);

if (process.env.PUBLIC_URL) {
  const https = require('https');
  setInterval(() => {
    https.get(`${process.env.PUBLIC_URL.replace(/\/$/, '')}/health`, (res) => res.resume()).on('error', () => {});
  }, 10 * 60 * 1000);
}
