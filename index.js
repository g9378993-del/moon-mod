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
  const roles = member.roles.cache
    .filter((r) => r.id !== member.guild.id && !r.managed)
    .sort((a, b) => b.position - a.position)
    .map((r) => `${r.name} (${r.id})`)
    .join(' | ');
  return `Nom : ${member.user.username} (ID: ${member.id})\nRôles : ${roles || 'Aucun rôle personnalisé'}`;
}

function needsServerContext(text) {
  const keywords = ['salon', 'rôle', 'staff', 'canal', 'channel', 'role', 'quels salons', 'quels rôles', 'channels', 'roles', 'channel', 'guild', 'server', 'où', 'lequel', 'laquelle', 'which'];
  return keywords.some((k) => text.toLowerCase().includes(k));
}

// Client Discord avec configuration complète
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel, Partials.Message],
});

const INSTANCE_ID = `moon-${process.env.INSTANCE_NAME || 'local'}-${Date.now()}`;
let dbReadyPromise = new Promise((r) => {
  db.onceReady(() => r());
});

// ================================================================
// COMMANDES SLASH
// ================================================================

const commands = [
  new SlashCommandBuilder().setName('ask').setDescription("Poser une question à l'IA (répond dans ta langue)")
    .addStringOption((o) => o.setName('question').setDescription('Ta question').setRequired(true)),

  new SlashCommandBuilder().setName('deobf').setDescription('Déobfusquer un script Lua/Luau protégé (indépendant de l\'IA)')
    .addAttachmentOption((o) => o.setName('fichier').setDescription('Le script .lua/.luau/.txt à déobfusquer').setRequired(true))
    .addBooleanOption((o) => o.setName('rapide').setDescription('Trace seulement, sans dévirtualisation (plus rapide, moins complet)')),

  new SlashCommandBuilder().setName('help').setDescription('Voir toutes les commandes'),
].map((c) => c.setDMPermission(false).toJSON());

commands.push(...economy.commands, ...perms.commands, ...constructionCmds.commands, ...trade.commands, ...bf.commands);
perms.setCommandNames(commands.map((c) => c.name));


const ownerCommands = [
  new SlashCommandBuilder().setName('diag').setDescription('(Toi uniquement) État du bot : stockage, doublons, serveurs'),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const body = [...commands, ...ownerCommands];
  try {
    console.log(`Mise à jour de ${body.length} commandes slash globales...`);
    await rest.put(Routes.applicationCommands(process.env.DISCORD_APPLICATION_ID), { body });
    console.log(`✅ ${body.length} commandes enregistrées.`);
  } catch (error) {
    console.error('Erreur lors de l\'enregistrement des commandes :', error);
  }
}

// ================================================================
// HANDLERS DE COMMANDES MODÉRATION
// ================================================================

async function executeModAction({ guild, actorMember, action, user_id, reason, duration }) {
  const target = await guild.members.fetch(user_id).catch(() => null);
  if (!target) return { error: '❌ Utilisateur introuvable.' };
  try {
    switch (action) {
      case 'kick':
        await target.kick(reason);
        return { message: `${target.user.username} a été expulsé (kick).` };
      case 'ban':
        await guild.bans.create(user_id, { reason });
        return { message: `${target.user.username} a été banni.` };
      case 'timeout':
        const ms = { '1h': 3600000, '24h': 86400000, '7d': 604800000 }[duration] || 3600000;
        await target.timeout(ms, reason);
        return { message: `${target.user.username} est en timeout pour ${duration}.` };
      default:
        return { error: '❌ Action inconnue.' };
    }
  } catch (e) {
    return { error: `Erreur lors de l'exécution : ${e.message}` };
  }
}

// ================================================================
// GESTION DES INTERACTIONS (BOUTONS, SÉLECTS, COMMANDES SLASH)
// ================================================================

async function handleModCommand(interaction, guild, g) {
  const { commandName } = interaction;

  // Warn/remove warn
  if (commandName === 'warn') {
    const target = interaction.options.getUser('user');
    const reason = interaction.options.getString('raison') || 'Pas de raison fournie';
    const duration = interaction.options.getString('duree') || 'permanente';
    const res = await executeModAction({ guild, actorMember: interaction.member, action: 'warn', user_id: target.id, reason: `${reason} (durée: ${duration})` });
    await interaction.editReply(res.error ? `❌ ${res.error}` : `✅ ${res.message}`);
    return;
  }

  // Kick / Ban / Timeout
  if (['kick', 'ban', 'timeout'].includes(commandName)) {
    const target = interaction.options.getUser('user');
    const reason = interaction.options.getString('raison') || 'Pas de raison fournie';
    const duration = interaction.options.getString('duree') || '1h';
    const res = await executeModAction({ guild, actorMember: interaction.member, action: commandName, user_id: target.id, reason, duration });
    await interaction.editReply(res.error ? `❌ ${res.error}` : `✅ ${res.message}`);
    return;
  }

  // Warnings
  if (commandName === 'warnings') {
    const target = interaction.options.getUser('user');
    const userWarnings = g.userWarnings?.[target.id] || [];
    const warnText = userWarnings.length === 0 ? 'Aucun avertissement.' : userWarnings.map((w, i) => `${i + 1}. ${w.reason || 'Pas de raison'} (expiration: ${w.expiresAt || 'N/A'})`).join('\n');
    await interaction.editReply(`Avertissements de ${target.username}:\n${warnText}`);
    return;
  }

  // Modlogs
  if (commandName === 'modlogs') {
    const logs = g.modLogs || [];
    const text = logs.slice(-10).reverse().map((l) => `[${l.timestamp || '?'}] ${l.action}: ${l.reason || 'N/A'}`).join('\n') || 'Aucun log.';
    await interaction.editReply(`Logs de modération (derniers 10):\n\`\`\`\n${text}\n\`\`\``);
    return;
  }

  // Case (voir un log spécifique)
  if (commandName === 'case') {
    const caseNum = interaction.options.getInteger('numero');
    const caseLog = (g.modLogs || [])[caseNum - 1];
    if (!caseLog) { await interaction.editReply('Case introuvable.'); return; }
    await interaction.editReply(`Case ${caseNum}: ${JSON.stringify(caseLog, null, 2)}`);
    return;
  }

  // Staffrole
  if (commandName === 'staffrole') {
    const role = interaction.options.getRole('role');
    if (!g.staffRoles) g.staffRoles = [];
    if (g.staffRoles.includes(role.id)) {
      g.staffRoles = g.staffRoles.filter((r) => r !== role.id);
      await db.updateGuild(guild.id, { staffRoles: g.staffRoles });
      await interaction.editReply(`✅ ${role.name} n'est plus un rôle staff.`);
    } else {
      g.staffRoles.push(role.id);
      await db.updateGuild(guild.id, { staffRoles: g.staffRoles });
      await interaction.editReply(`✅ ${role.name} est maintenant un rôle staff.`);
    }
    return;
  }

  // Warnactions (définir les actions auto quand warn atteint N)
  if (commandName === 'warnactions') {
    const num = interaction.options.getInteger('nombre');
    const action = interaction.options.getString('action');
    if (!g.warnActions) g.warnActions = {};
    g.warnActions[num] = action;
    await db.updateGuild(guild.id, { warnActions: g.warnActions });
    await interaction.editReply(`✅ À partir de ${num} avertissements, l'action sera: ${action}`);
    return;
  }

  // Automod
  if (commandName === 'automod') {
    const toggle = interaction.options.getBoolean('actif');
    if (!g.automod) g.automod = { enabled: false, rules: {} };
    g.automod.enabled = toggle;
    await db.updateGuild(guild.id, { automod: g.automod });
    await interaction.editReply(`✅ Automod est maintenant ${toggle ? 'actif' : 'inactif'}.`);
    return;
  }

  // Help
  if (commandName === 'help') {
    const embed = new EmbedBuilder()
      .setTitle('Commandes disponibles')
      .setDescription('Liste complète des commandes du bot')
      .addFields(
        { name: 'Moderation', value: '/warn, /kick, /ban, /timeout, /warnings, /modlogs, /case, /staffrole', inline: false },
        { name: 'Economy', value: '/balance, /daily, /deposit, /withdraw', inline: false },
        { name: 'Other', value: '/ask, /deobf, /help', inline: false }
      )
      .setColor(0xFF0000);
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // Setmodlog
  if (commandName === 'setmodlog') {
    const channel = interaction.options.getChannel('salon');
    g.modLogChannel = channel.id;
    await db.updateGuild(guild.id, { modLogChannel: channel.id });
    await interaction.editReply(`✅ Logs de modération envoyés vers ${channel.name}`);
    return;
  }

  // Vider
  if (commandName === 'vider') {
    const amount = interaction.options.getInteger('nombre');
    const messages = await interaction.channel.messages.fetch({ limit: amount });
    await interaction.channel.bulkDelete(messages);
    await interaction.editReply(`✅ ${amount} messages supprimés.`);
    return;
  }

  // Scanalts
  if (commandName === 'scanalts') {
    const target = interaction.options.getUser('user');
    const created = target.createdAt;
    const now = new Date();
    const ageMs = now - created;
    const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
    const riskLevel = ageDays < 7 ? 'TRÈS HAUT' : ageDays < 30 ? 'HAUT' : ageDays < 90 ? 'MOYEN' : 'BAS';
    const userId = target.id;
    const embed = new EmbedBuilder()
      .setTitle(`Scan alt : ${target.username}`)
      .addFields(
        { name: 'Compte créé', value: `${created.toLocaleDateString()} (${ageDays} jours)`, inline: true },
        { name: 'Risque', value: riskLevel, inline: true },
      )
      .setColor(riskLevel === 'TRÈS HAUT' ? 0xFF0000 : riskLevel === 'HAUT' ? 0xFF6600 : 0xFFFF00)
      .setFooter({ text: `ID: ${userId}` });
    const row = new ActionRowBuilder()
      .addComponents(
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
    if (action === 'cancel') { await interaction.update({ content: 'Annulé, aucune action effectuée.', embeds: [], components: [] }); return; }
    await interaction.deferUpdate();
    const res = await executeModAction({ guild: interaction.guild, actorMember: interaction.member, action, user_id: userId, reason: 'Compte suspecté alt (scan /scanalts)', duration: action === 'timeout' ? '24h' : undefined });
    await interaction.editReply({ content: res.error ? `[ERROR] ${res.error}` : `[OK] ${res.message}`, embeds: [], components: [] });
    return;
  }
}

// Route d'interaction pour les sélects, boutons, etc. AVANT le handler de commandes slash
async function routeSelect(interaction, guild, g) {
  // Patch 4: delete confirm/cancel buttons
  if (interaction.customId.startsWith('delete_confirm_')) {
    const channelId = interaction.customId.split('_')[2];
    const channel = interaction.guild.channels.cache.get(channelId);
    if (channel && channel.deletable) {
      await channel.delete('Suppression confirmee par ' + interaction.user.tag).catch(() => {});
      await interaction.update({ content: '[OK] Salon supprime.', embeds: [], components: [] });
    } else {
      await interaction.update({ content: '[ERROR] Impossible de supprimer le salon.', embeds: [], components: [] });
    }
    return;
  }
  if (interaction.customId.startsWith('delete_cancel_')) {
    await interaction.update({ content: '[CANCEL] Suppression annulee.', embeds: [], components: [] });
    return;
  }
  
  // Patch 5: handle multi-select delete
  if (interaction.isStringSelectMenu() && interaction.customId === 'delete_select_channels') {
    await constructionCmds.handleSelectMenu(interaction, client, g, db);
    return;
  }
}


// ================================================================
// ÉVÉNEMENTS DISCORD
// ================================================================

async function handleCommand(interaction) {
  const guild = interaction.guild;
  const g = await db.getGuild(guild.id);

  // Route builders
  if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
    await routeSelect(interaction, guild, g);
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const autocompleteOptions = {
    from_type: 'String',
    from_choices: ['eco', 'perm', 'trade', 'bf'],
  };

  // Deobf
  if (interaction.commandName === 'deobf') {
    await interaction.deferReply({ ephemeral: true });
    const file = interaction.options.getAttachment('fichier');
    const fast = interaction.options.getBoolean('rapide');
    const result = await downloadAndDeobf(file.url, file.name, fast ? ['--no-devirt'] : []);
    if (!result.ok) {
      await interaction.editReply(`[ERROR] Echec de la deobfuscation :\n\`\`\`\n${(result.error || '').slice(0, 1800)}\n\`\`\``);
    } else {
      await interaction.editReply({ content: deobfMessage(result), files: [{ attachment: result.outPath, name: `deobf-${result.safeName.replace(/\.[^.]+$/, '')}.lua` }] });
    }
    fs.rm(result.tmpDir, { recursive: true, force: true }, () => {});
    return;
  }

  if (bf.isBFCommand(interaction.commandName)) { await bf.handleCommand(interaction); return; }
  if (economy.isEconomyCommand(interaction.commandName)) { await economy.handleCommand(interaction); return; }
  if (trade.isTradeCommand(interaction.commandName)) { await trade.handleCommand(interaction); return; }

  // Patch 3: construction commands check (BEFORE the 'ask' command)
  if (constructionCmds.isConstructionCommand(interaction.commandName)) {
    if (!perms.canUseCommand(interaction.member, g, interaction.commandName)) {
      await interaction.reply({ content: "Tu n'as pas la permission d'utiliser cette commande (Administrateur, Gerer le serveur, ou un role autorise via `/staffrole`).", ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: ['buildmode', 'copychannels'].includes(interaction.commandName) });
    await constructionCmds.handleCommand(interaction, client, g, db);
    return;
  }

  if (interaction.commandName === 'ask') {
    await interaction.deferReply();
    const question = interaction.options.getString('question');
    const canModerate = perms.hasStaff(interaction.member, g);
    const res = await ai.askClaude({ channelId: interaction.channelId, userId: interaction.user.id, userName: interaction.user.username, userText: question, persona: g.aiPersona, serverContext: needsServerContext(question) ? buildServerContext(guild) : null, speakerInfo: buildSpeakerInfo(interaction.member), guild, canModerate, modExecutor: canModerate ? (args) => executeModAction({ guild, actorMember: interaction.member, ...args }) : null });
    await interaction.editReply(res.error ? `[ERROR] ${res.error}` : res.text);
    return;
  }

  const nonStaffAllowed = new Set(['warnings', 'help']);
  if (!nonStaffAllowed.has(interaction.commandName) && !perms.canUseCommand(interaction.member, g, interaction.commandName)) {
    await interaction.reply({ content: "Tu n'as pas la permission d'utiliser cette commande (Administrateur, Gerer le serveur, ou un role autorise via `/staffrole`).", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: ['warnings', 'modlogs', 'case', 'staffrole', 'warnactions', 'automod', 'ai', 'help', 'setmodlog', 'vider', 'scanalts'].includes(interaction.commandName) });
  await handleModCommand(interaction, guild, g);
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    await dbReadyPromise;
    if (interaction.isAutocomplete()) { if (perms.isPermCommand(interaction.commandName)) await perms.autocomplete(interaction); else if (trade.isTradeCommand(interaction.commandName)) await trade.autocomplete(interaction); else if (bf.isBFCommand(interaction.commandName)) await bf.autocomplete(interaction); else await economy.autocomplete(interaction); return; }
    if (interaction.customId && interaction.customId.startsWith('eco:')) { await economy.handleComponent(interaction); return; }
    if (interaction.customId && interaction.customId.startsWith('trade:')) { await trade.handleComponent(interaction); return; }
    if (interaction.customId && interaction.customId.startsWith('bf:')) { await bf.handleComponent(interaction); return; }
    await handleCommand(interaction);
  } catch (error) {
    console.error('Erreur lors du traitement de l\'interaction :', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: `Erreur: ${error.message}`, ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: `Erreur: ${error.message}`, ephemeral: true }).catch(() => {});
    }
  }
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot || message.author.id === client.user.id) return;
    await dbReadyPromise;
    const guild = message.guild;
    if (!guild) return;
    const g = await db.getGuild(guild.id);
    if (automod.shouldFilter(message, g)) {
      await message.delete().catch(() => {});
      const user = await message.author.createDM().catch(() => null);
      if (user) await user.send(`Votre message sur ${guild.name} a été supprimé par automod.`).catch(() => {});
    }
  } catch (error) {
    console.error('Erreur lors du traitement du message :', error);
  }
});

client.on(Events.GuildCreate, async (guild) => {
  console.log(`Bot rejoint au serveur : ${guild.name} (${guild.id})`);
  await db.getGuild(guild.id);
  const owner = await guild.fetchOwner().catch(() => null);
  if (owner) {
    try {
      const dm = await owner.createDM();
      await dm.send(`Merci d'avoir ajouté moon-bot! Utilisez /help pour voir les commandes disponibles.`);
    } catch (e) {
      console.error(`Impossible d'envoyer un message au propriétaire : ${e.message}`);
    }
  }
});

// ================================================================
// DÉMARRAGE / SUIVI DE VIE
// ================================================================
client.once(Events.ClientReady, async () => {
  console.log(`Connecte en tant que ${client.user.tag} (instance ${INSTANCE_ID})`);
  await dbReadyPromise;
  console.log(`Serveurs actuels (${client.guilds.cache.size}) :`, [...client.guilds.cache.values()].map((g) => `${g.name} (${g.id})`).join(' | '));
  await registerCommands();
  economy.startVoiceTracking(client);
  const st = db.getStatus();
  if (!st.persistent && process.env.OWNER_ID) {
    try {
      const u = await client.users.fetch(process.env.OWNER_ID);
      await u.send(`[WARNING] Bot tourne SANS stockage persistant. Raison : ${st.uriSet ? `MongoDB inaccessible (${st.connectError || '?'})` : 'MONGODB_URI absent'}.`);
    } catch (e) {
      console.error(`Impossible de notifier le proprietaire : ${e.message}`);
    }
  }
});

// ================================================================
// UTILITAIRES
// ================================================================

function deobfMessage(result) {
  const lines = result.output.split('\n').slice(0, 50);
  return `Deobfuscation reussie (${result.lines} lignes):\n\`\`\`lua\n${lines.join('\n')}\n\`\`\``;
}

async function downloadAndDeobf(url, filename, args = []) {
  const tmpDir = path.join(os.tmpdir(), `deobf-${Date.now()}`);
  const inPath = path.join(tmpDir, filename);
  const outPath = path.join(tmpDir, `deobf-${filename}`);

  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Erreur HTTP: ${response.status}`);
    const buffer = await response.arrayBuffer();
    fs.writeFileSync(inPath, Buffer.from(buffer));

    const result = await new Promise((resolve) => {
      const proc = spawn('lua', ['deobf.lua', inPath, ...args]);
      let output = '';
      proc.stdout.on('data', (d) => { output += d; });
      proc.on('close', (code) => {
        resolve({ ok: code === 0, output, lines: output.split('\n').length, tmpDir, outPath, safeName: filename.replace(/[^a-z0-9._-]/gi, '_') });
      });
    });

    if (result.ok) fs.writeFileSync(outPath, result.output);
    return result;
  } catch (e) {
    return { ok: false, error: e.message, tmpDir, outPath, safeName: filename.replace(/[^a-z0-9._-]/gi, '_') };
  }
}

// ================================================================
// DÉMARRAGE DU BOT
// ================================================================
client.login(process.env.DISCORD_TOKEN);
