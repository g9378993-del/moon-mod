console.log('[BOOT] index.js chargé');
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./db');
const mod = require('./moderation');
if (mod.COLORS) { for (const k of Object.keys(mod.COLORS)) mod.COLORS[k] = 0xFF0000; }
const automod = require('./automod');
const ai = require('./ai');
const economy = require('./economy');
const perms = require('./perms');
const constructionCmds = require('./construction_commands');
const trade = require('./trade');
const bf = require('./brainrot-finder');
const server = require('./server');

const {
  Client, GatewayIntentBits, Partials, Events, PermissionFlagsBits,
  ChannelType, EmbedBuilder, REST, Routes, SlashCommandBuilder,
  AttachmentBuilder, ActionRowBuilder, StringSelectMenuBuilder,
  ButtonBuilder, ButtonStyle, MessageFlags,
} = require('discord.js');

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException',  (err) => console.error('Uncaught exception:',  err));

// Auto-ping anti-veille Render
if (process.env.PUBLIC_URL) {
  setInterval(() => {
    const url = new URL(process.env.PUBLIC_URL);
    const httpMod = url.protocol === 'https:' ? require('https') : require('http');
    httpMod.get(process.env.PUBLIC_URL, () => {}).on('error', () => {});
  }, 10 * 60 * 1000);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

let dbReadyPromise = db.initDb();

client.on('error',           e        => console.error('[CLIENT ERROR]', e));
client.on('shardError',      e        => console.error('[SHARD ERROR]', e));
client.on('shardDisconnect', (e, id)  => console.error('[SHARD DISCONNECT]', id, e?.code, e?.reason));
client.on('shardReady',      id       => console.log('[SHARD READY]', id));
client.on('shardResume',     id       => console.log('[SHARD RESUME]', id));
client.on('warn',            m        => console.warn('[WARN]', m));
setTimeout(() => { if (!client.isReady()) console.error('[BOOT] toujours pas prêt après 60s'); }, 60000);

// ─── Helpers ────────────────────────────────────────────────────────────────

async function getGuildConfig(guildId) {
  return Promise.race([
    Promise.resolve(db.get(guildId)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), 1500)),
  ]).catch(err => { console.error('getGuildConfig:', err.message); return {}; });
}

function buildServerContext(guild) {
  const channels = guild.channels.cache
    .filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map(c => `#${c.name} (<#${c.id}>)`);
  const roles = guild.roles.cache
    .filter(r => r.id !== guild.id && !r.managed)
    .sort((a, b) => b.position - a.position)
    .map(r => `@${r.name}`);
  return [channels.join('\n') || 'no channels', roles.join('\n') || 'no roles'].join('\n');
}

function buildSpeakerInfo(member) {
  const roles = member.roles.cache
    .filter(r => r.id !== member.guild.id && !r.managed)
    .sort((a, b) => b.position - a.position)
    .map(r => r.name).join(', ');
  return `${member.user.username} (${roles || 'no roles'})`;
}

function needsServerContext(text) {
  return ['salon', 'channel', 'role', 'staff', 'canal'].some(k => text.toLowerCase().includes(k));
}

// ─── Définition des commandes ────────────────────────────────────────────────

const coreCommands = [
  new SlashCommandBuilder()
    .setName('ask').setDescription('Poser une question à l\'IA')
    .addStringOption(o => o.setName('question').setDescription('Ta question').setRequired(true))
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('ai').setDescription('Gérer l\'IA dans les salons')
    .addSubcommand(s => s.setName('channel-add').setDescription('Activer l\'IA dans un salon')
      .addChannelOption(o => o.setName('salon').setDescription('Salon').setRequired(true).addChannelTypes(ChannelType.GuildText)))
    .addSubcommand(s => s.setName('channel-remove').setDescription('Désactiver l\'IA dans un salon')
      .addChannelOption(o => o.setName('salon').setDescription('Salon').setRequired(true).addChannelTypes(ChannelType.GuildText)))
    .addSubcommand(s => s.setName('list').setDescription('Voir les salons où l\'IA est active'))
    .addSubcommand(s => s.setName('persona').setDescription('Changer la personnalité de l\'IA')
      .addStringOption(o => o.setName('texte').setDescription('Instruction (vide = défaut)').setMaxLength(300)))
    .addSubcommand(s => s.setName('reset').setDescription('Réinitialiser l\'historique de conversation'))
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('clear').setDescription('Supprimer des messages')
    .addIntegerOption(o => o.setName('nombre').setDescription('Nombre de messages à supprimer (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('warn').setDescription('Avertir un membre')
    .addUserOption(o => o.setName('membre').setDescription('Le membre').setRequired(true))
    .addStringOption(o => o.setName('raison').setDescription('Raison').setRequired(true))
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('warnings').setDescription('Voir les avertissements d\'un membre')
    .addUserOption(o => o.setName('membre').setDescription('Le membre').setRequired(true))
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('kick').setDescription('Expulser un membre')
    .addUserOption(o => o.setName('membre').setDescription('Le membre').setRequired(true))
    .addStringOption(o => o.setName('raison').setDescription('Raison'))
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('ban').setDescription('Bannir un membre')
    .addUserOption(o => o.setName('membre').setDescription('Le membre').setRequired(true))
    .addStringOption(o => o.setName('raison').setDescription('Raison'))
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('unban').setDescription('Débannir un utilisateur')
    .addStringOption(o => o.setName('id').setDescription('ID Discord de l\'utilisateur').setRequired(true))
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('timeout').setDescription('Mettre un membre en sourdine temporairement')
    .addUserOption(o => o.setName('membre').setDescription('Le membre').setRequired(true))
    .addStringOption(o => o.setName('duree').setDescription('Durée ex: 10m, 2h, 1d').setRequired(true))
    .addStringOption(o => o.setName('raison').setDescription('Raison'))
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('untimeout').setDescription('Retirer le timeout d\'un membre')
    .addUserOption(o => o.setName('membre').setDescription('Le membre').setRequired(true))
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('modlogs').setDescription('Voir les logs de modération d\'un membre')
    .addUserOption(o => o.setName('membre').setDescription('Le membre').setRequired(true))
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('setmodlog').setDescription('Définir le salon des logs de modération')
    .addChannelOption(o => o.setName('salon').setDescription('Salon').setRequired(true).addChannelTypes(ChannelType.GuildText))
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('help').setDescription('Afficher les commandes disponibles')
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('deobf').setDescription('Déobfusquer un script')
    .addAttachmentOption(o => o.setName('fichier').setDescription('Fichier').setRequired(true))
    .setDMPermission(false),
].map(c => c.toJSON());

const allCommands = [
  ...coreCommands,
  ...economy.commands,
  ...perms.commands,
  ...constructionCmds.commands,
  ...trade.commands,
  ...bf.commands,
];

perms.setCommandNames(allCommands.map(c => c.name));

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log(`Registering ${allCommands.length} commands...`);
    await rest.put(Routes.applicationCommands(process.env.DISCORD_APPLICATION_ID), { body: allCommands });
    console.log('[OK] Commands registered');
  } catch (error) {
    console.error('Command registration error:', error);
  }
}

// ─── Modération ──────────────────────────────────────────────────────────────

async function executeModAction({ guild, action, user_id, reason, durationMs }) {
  if (action === 'unban') {
    await guild.bans.remove(user_id, reason).catch(e => { throw e; });
    return { message: `Utilisateur \`${user_id}\` débanni` };
  }
  const target = await guild.members.fetch(user_id).catch(() => null);
  if (!target) return { error: 'Membre introuvable sur ce serveur' };
  const botMember = guild.members.me;
  const check = mod.canTarget({ permissions: { has: () => true }, roles: { highest: { position: 999 } }, id: 'bot', guild }, target, botMember);
  if (!check.ok) return { error: check.reason };
  if (action === 'kick')    { await target.kick(reason); return { message: `${target.user.username} expulsé` }; }
  if (action === 'ban')     { await guild.bans.create(user_id, { reason }); return { message: `${target.user.username} banni` }; }
  if (action === 'timeout') { await target.timeout(durationMs || 3600000, reason); return { message: `${target.user.username} mis en timeout` }; }
  if (action === 'untimeout') { await target.timeout(null); return { message: `${target.user.username} : timeout retiré` }; }
  return { error: 'Action inconnue' };
}

async function handleModCommand(interaction, guild, g) {
  const cmd = interaction.commandName;

  if (cmd === 'clear') {
    const nombre = interaction.options.getInteger('nombre');
    if (!interaction.channel.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.ManageMessages)) {
      await interaction.editReply('❌ Je n\'ai pas la permission de supprimer des messages ici.');
      return;
    }
    const deleted = await interaction.channel.bulkDelete(nombre, true).catch(e => { throw e; });
    await interaction.editReply({ content: `✅ ${deleted.size} message(s) supprimé(s).`, flags: MessageFlags.Ephemeral });
    return;
  }

  if (cmd === 'warn') {
    const target = interaction.options.getUser('membre');
    const raison = interaction.options.getString('raison');
    const record = db.addCase(g, { type: 'warn', userId: target.id, moderatorId: interaction.user.id, reason: raison });
    await db.save(guild.id);
    const warnCount = g.cases.filter(c => c.type === 'warn' && c.userId === target.id).length;
    const embed = mod.caseEmbed(record, guild.name);
    await mod.postToModLog(client, g, embed);
    const escalation = mod.computeWarnEscalation(g, warnCount);
    let extra = '';
    if (escalation) {
      const member = await guild.members.fetch(target.id).catch(() => null);
      if (member) {
        if (escalation.action === 'timeout') { await member.timeout(escalation.minutes * 60000, `Escalade : ${warnCount} avertissements`).catch(() => {}); extra = ` — timeout ${escalation.minutes} min appliqué automatiquement`; }
        if (escalation.action === 'ban')     { await guild.bans.create(target.id, { reason: `Escalade : ${warnCount} avertissements` }).catch(() => {}); extra = ' — ban automatique appliqué'; }
      }
    }
    await interaction.editReply(`⚠️ <@${target.id}> averti (cas #${record.id}, ${warnCount} warn(s) total)${extra}.`);
    return;
  }

  if (cmd === 'warnings') {
    const target = interaction.options.getUser('membre');
    const warns = g.cases.filter(c => c.type === 'warn' && c.userId === target.id);
    if (!warns.length) { await interaction.editReply(`ℹ️ <@${target.id}> n\'a aucun avertissement.`); return; }
    const lines = warns.slice(-10).map(c => `**#${c.id}** — ${c.reason} *(${new Date(c.createdAt).toLocaleDateString('fr-FR')})*`);
    const embed = new EmbedBuilder().setColor(0xFF0000).setTitle(`⚠️ Avertissements de ${target.username} (${warns.length})`).setDescription(lines.join('\n'));
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (cmd === 'modlogs') {
    const target = interaction.options.getUser('membre');
    const cases = g.cases.filter(c => c.userId === target.id);
    if (!cases.length) { await interaction.editReply(`ℹ️ Aucun cas trouvé pour <@${target.id}>.`); return; }
    const lines = cases.slice(-15).map(c => `**#${c.id}** \`${c.type}\` — ${c.reason} *(${new Date(c.createdAt).toLocaleDateString('fr-FR')})*`);
    const embed = new EmbedBuilder().setColor(0xFF0000).setTitle(`📋 Logs de ${target.username} (${cases.length})`).setDescription(lines.join('\n'));
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (cmd === 'setmodlog') {
    const channel = interaction.options.getChannel('salon');
    g.modLogChannelId = channel.id;
    await db.save(guild.id);
    await interaction.editReply(`✅ Salon de logs de modération : <#${channel.id}>.`);
    return;
  }

  if (['kick', 'ban', 'timeout', 'untimeout'].includes(cmd)) {
    const target = interaction.options.getUser('membre');
    const raison = interaction.options.getString('raison') || 'Aucune raison';
    const duree  = interaction.options.getString('duree');
    const durationMs = duree ? mod.parseDuration(duree) : 3600000;
    if (duree && !durationMs) { await interaction.editReply('❌ Durée invalide. Exemples : `10m`, `2h`, `1d`.'); return; }
    const res = await executeModAction({ guild, action: cmd, user_id: target.id, reason: raison, durationMs });
    if (res.error) { await interaction.editReply(`❌ ${res.error}`); return; }
    const record = db.addCase(g, { type: cmd, userId: target.id, moderatorId: interaction.user.id, reason: raison, extra: durationMs ? { ms: durationMs } : null });
    await db.save(guild.id);
    await mod.postToModLog(client, g, mod.caseEmbed(record, guild.name));
    await interaction.editReply(`✅ ${res.message}.`);
    return;
  }

  if (cmd === 'unban') {
    const userId = interaction.options.getString('id').trim();
    const res = await executeModAction({ guild, action: 'unban', user_id: userId, reason: 'Unban via commande' });
    if (res.error) { await interaction.editReply(`❌ ${res.error}`); return; }
    await interaction.editReply(`✅ ${res.message}.`);
    return;
  }

  if (cmd === 'help') {
    const embed = new EmbedBuilder().setColor(0xFF0000).setTitle('📋 Commandes disponibles').setDescription([
      '**Modération**',
      '`/warn` `/warnings` `/kick` `/ban` `/unban` `/timeout` `/untimeout` `/modlogs` `/setmodlog` `/clear`',
      '',
      '**IA**',
      '`/ask` `/ai channel-add` `/ai channel-remove` `/ai list` `/ai persona` `/ai reset`',
      '',
      '**Économie**',
      '`/coins` `/panelcoins` `/ecoadmin` `/ecoconfig` `/shop`',
      '',
      '**Permissions**',
      '`/staffrole` `/permuser`',
      '',
      '**Construction**',
      '`/buildmode` `/createchannel` `/deletechannel` `/copychannels`',
      '',
      '**Brainrot**',
      '`/brainrotfind` `/brainrotfinder` `/brainrotconfig` `/brainrot` `/tradeconfig`',
    ].join('\n'));
    await interaction.editReply({ embeds: [embed] });
    return;
  }
}

// ─── Handler /ai ─────────────────────────────────────────────────────────────

async function handleAiCommand(interaction, guild, g) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'reset') {
    ai.resetHistory(interaction.channelId, interaction.user.id);
    await interaction.reply({ content: '✅ Historique réinitialisé.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (sub === 'list') {
    const channels = g.aiChannels || [];
    await interaction.reply({
      content: channels.length
        ? `📋 Salons avec IA active :\n${channels.map(id => `<#${id}>`).join('\n')}`
        : "ℹ️ L'IA n'est active dans aucun salon.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!perms.canUseCommand(interaction.member, g, 'ai')) {
    await interaction.reply({ content: '❌ Pas la permission.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (sub === 'channel-add') {
    const channel = interaction.options.getChannel('salon');
    if (!g.aiChannels) g.aiChannels = [];
    if (g.aiChannels.includes(channel.id)) {
      await interaction.editReply(`ℹ️ L'IA est déjà active dans <#${channel.id}>.`);
      return;
    }
    g.aiChannels.push(channel.id);
    await db.save(guild.id);
    await interaction.editReply(`✅ IA activée dans <#${channel.id}>.`);
    return;
  }

  if (sub === 'channel-remove') {
    const channel = interaction.options.getChannel('salon');
    if (!g.aiChannels || !g.aiChannels.includes(channel.id)) {
      await interaction.editReply(`ℹ️ L'IA n'était pas active dans <#${channel.id}>.`);
      return;
    }
    g.aiChannels = g.aiChannels.filter(id => id !== channel.id);
    await db.save(guild.id);
    await interaction.editReply(`✅ IA désactivée dans <#${channel.id}>.`);
    return;
  }

  if (sub === 'persona') {
    const texte = interaction.options.getString('texte') || null;
    g.aiPersona = texte;
    await db.save(guild.id);
    await interaction.editReply(texte ? `✅ Personnalité mise à jour.` : `✅ Personnalité remise par défaut.`);
    return;
  }
}

// ─── Routing principal ───────────────────────────────────────────────────────

async function routeComponent(interaction, guild, g) {
  if (interaction.customId.startsWith('delete_confirm_')) {
    const ids = interaction.customId.slice('delete_confirm_'.length).split(',');
    let deleted = 0;
    for (const chId of ids) {
      const ch = guild.channels.cache.get(chId);
      if (ch && ch.deletable) { await ch.delete('Deleted by ' + interaction.user.tag).catch(() => {}); deleted++; }
    }
    await interaction.update({ content: `✅ ${deleted} salon(s) supprimé(s).`, embeds: [], components: [] });
    return;
  }
  if (interaction.customId.startsWith('delete_cancel_')) {
    await interaction.update({ content: '❌ Annulé.', embeds: [], components: [] });
    return;
  }
  if (interaction.isStringSelectMenu() && interaction.customId === 'delete_select_channels') {
    await constructionCmds.handleSelectMenu(interaction, client, g, db);
    return;
  }
  if (interaction.isButton() && !interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => {});
  }
}

const MOD_COMMANDS = new Set(['clear','warn','warnings','kick','ban','unban','timeout','untimeout','modlogs','setmodlog','help','deobf']);

async function handleCommand(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  const g = await getGuildConfig(guild.id);

  // Composants (boutons, menus, modals)
  if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
    await routeComponent(interaction, guild, g);
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const cmd = interaction.commandName;
  console.log('[CMD]', cmd);

  // Modules avec leur propre deferReply interne
  if (bf.isBFCommand(cmd))           { await bf.handleCommand(interaction); return; }
  if (economy.isEconomyCommand(cmd)) { await economy.handleCommand(interaction); return; }
  if (trade.isTradeCommand(cmd))     { await trade.handleCommand(interaction); return; }
  if (perms.isPermCommand(cmd))      { await perms.handleCommand(interaction); return; }

  // /ai
  if (cmd === 'ai') { await handleAiCommand(interaction, guild, g); return; }

  // Construction
  if (constructionCmds.isConstructionCommand(cmd)) {
    if (!perms.canUseCommand(interaction.member, g, cmd)) {
      await interaction.reply({ content: '❌ Pas la permission.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: ['buildmode','copychannels'].includes(cmd) ? MessageFlags.Ephemeral : undefined });
    await constructionCmds.handleCommand(interaction, client, g, db);
    return;
  }

  // /ask
  if (cmd === 'ask') {
    await interaction.deferReply();
    const question = interaction.options.getString('question');
    const res = await ai.askClaude({
      channelId: interaction.channelId, userId: interaction.user.id,
      userName: interaction.user.username, userText: question,
      persona: g.aiPersona,
      serverContext: needsServerContext(question) ? buildServerContext(guild) : null,
      speakerInfo: buildSpeakerInfo(interaction.member), guild,
      canModerate: perms.hasStaff(interaction.member, g),
    });
    await interaction.editReply(res.error ? `❌ ${res.error}` : res.text);
    return;
  }

  // Commandes de modération
  if (MOD_COMMANDS.has(cmd)) {
    const publicCmds = new Set(['warnings', 'help']);
    if (!publicCmds.has(cmd) && !perms.canUseCommand(interaction.member, g, cmd)) {
      await interaction.reply({ content: '❌ Pas la permission.', flags: MessageFlags.Ephemeral });
      return;
    }
    const ephemeralCmds = new Set(['warnings','modlogs','setmodlog','help','deobf','clear']);
    await interaction.deferReply({ flags: ephemeralCmds.has(cmd) ? MessageFlags.Ephemeral : undefined });
    await handleModCommand(interaction, guild, g);
    return;
  }
}

// ─── Events ──────────────────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  console.log('[INTERACTION]', interaction.type, interaction.commandName || interaction.customId || '');
  try {
    if (interaction.isAutocomplete()) {
      if (perms.isPermCommand(interaction.commandName))      await perms.autocomplete(interaction);
      else if (trade.isTradeCommand(interaction.commandName)) await trade.autocomplete(interaction);
      else if (bf.isBFCommand(interaction.commandName))      await bf.autocomplete(interaction);
      else                                                    await economy.autocomplete(interaction);
      return;
    }
    if (interaction.customId?.startsWith('eco:'))   { await economy.handleComponent(interaction); return; }
    if (interaction.customId?.startsWith('trade:')) { await trade.handleComponent(interaction); return; }
    if (interaction.customId?.startsWith('bf:'))    { await bf.handleComponent(interaction); return; }
    await handleCommand(interaction);
  } catch (error) {
    console.error('Interaction error:', error);
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content: `❌ Erreur : ${error.message}` }).catch(() => {});
      else await interaction.reply({ content: `❌ Erreur : ${error.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    } catch (_) {}
  }
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot || !message.guild) return;
    await dbReadyPromise;
    const g = await getGuildConfig(message.guild.id);
    await automod.checkMessage(message, client, g, db);

    // IA dans les salons configurés
    if (g.aiEnabled !== false && Array.isArray(g.aiChannels) && g.aiChannels.includes(message.channelId) && message.content.trim()) {
      const res = await ai.askClaude({
        channelId: message.channelId, userId: message.author.id,
        userName: message.author.username, userText: message.content,
        persona: g.aiPersona,
        serverContext: needsServerContext(message.content) ? buildServerContext(message.guild) : null,
        speakerInfo: buildSpeakerInfo(message.member),
        guild: message.guild, canModerate: false,
      });
      if (res.text) message.reply({ content: res.text, allowedMentions: { repliedUser: false } }).catch(() => {});
    }
  } catch (error) { console.error('Message error:', error); }
});

client.on(Events.GuildCreate, async (guild) => {
  console.log(`Joined: ${guild.name}`);
  await getGuildConfig(guild.id);
});

client.once(Events.ClientReady, async () => {
  console.log(`Connected as ${client.user.tag}`);
  server.setClient(client);
  server.setDb(db);
  await registerCommands();
  await dbReadyPromise.catch(e => console.error('DB init failed:', e));
  console.log(`${client.guilds.cache.size} server(s)`);
  economy.startVoiceTracking(client);
});

console.log('[BOOT] login en cours...');
client.login(process.env.DISCORD_TOKEN)
  .then(() => console.log('[BOOT] login OK'))
  .catch(err => console.error('[BOOT] LOGIN FAILED:', err.message));
