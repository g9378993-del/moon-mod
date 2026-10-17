console.log('[BOOT] index.js chargé');
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
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
const { Client, GatewayIntentBits, Partials, Events, PermissionFlagsBits, ChannelType, EmbedBuilder, REST, Routes, SlashCommandBuilder, AttachmentBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

const http = require('http');
http.createServer((req, res) => res.end('OK')).listen(process.env.PORT || 3000);

// Auto-ping pour empêcher Render de mettre le service en veille (free tier)
if (process.env.PUBLIC_URL) {
  setInterval(() => {
    const url = new URL(process.env.PUBLIC_URL);
    const mod = url.protocol === 'https:' ? require('https') : require('http');
    mod.get(process.env.PUBLIC_URL, () => {}).on('error', () => {});
  }, 10 * 60 * 1000);
}

const INSTANCE_ID = `moon-${Date.now()}`;
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.DirectMessages], partials: [Partials.Channel, Partials.Message] });
let dbReadyPromise = db.initDb();

// ===== DIAGNOSTIC CONNEXION =====
client.on('error', e => console.error('[CLIENT ERROR]', e));
client.on('shardError', e => console.error('[SHARD ERROR]', e));
client.on('shardDisconnect', (e, id) => console.error('[SHARD DISCONNECT]', id, e?.code, e?.reason));
client.on('shardReady', id => console.log('[SHARD READY]', id));
client.on('shardResume', id => console.log('[SHARD RESUME]', id));
client.on('warn', m => console.warn('[WARN]', m));
setTimeout(() => {
  if (!client.isReady()) console.error('[BOOT] toujours pas prêt après 60s');
}, 60000);
// ================================

async function getGuildConfig(guildId) {
  return Promise.race([
    db.get(guildId),
    new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), 1500)),
  ]).catch(err => {
    console.error('getGuildConfig:', err.message);
    return {};
  });
}

function buildServerContext(guild) {
  const channels = guild.channels.cache.filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement).sort((a, b) => a.rawPosition - b.rawPosition).map(c => `#${c.name} (<#${c.id}>)`);
  const roles = guild.roles.cache.filter(r => r.id !== guild.id && !r.managed).sort((a, b) => b.position - a.position).map(r => `@${r.name}`);
  return [channels.join('\n') || 'no channels', roles.join('\n') || 'no roles'].join('\n');
}

function buildSpeakerInfo(member) {
  const roles = member.roles.cache.filter(r => r.id !== member.guild.id && !r.managed).sort((a, b) => b.position - a.position).map(r => r.name).join(', ');
  return `${member.user.username} (${roles || 'no roles'})`;
}

function needsServerContext(text) {
  return ['salon', 'channel', 'role', 'staff', 'canal'].some(k => text.toLowerCase().includes(k));
}

const commands = [
  new SlashCommandBuilder().setName('ask').setDescription('Ask AI').addStringOption(o => o.setName('question').setDescription('Question').setRequired(true)).setDMPermission(false).toJSON(),
  new SlashCommandBuilder().setName('deobf').setDescription('Deobfuscate script').addAttachmentOption(o => o.setName('fichier').setDescription('File').setRequired(true)).setDMPermission(false).toJSON(),
  new SlashCommandBuilder().setName('help').setDescription('Show commands').setDMPermission(false).toJSON(),
  // ===== COMMANDE AI CHANNEL-ADD AJOUTÉE =====
  new SlashCommandBuilder()
    .setName('ai')
    .setDescription('Gérer l\'IA dans les salons')
    .addSubcommand(s => s.setName('channel-add').setDescription('Activer l\'IA dans un salon (répond à tous les messages)')
      .addChannelOption(o => o.setName('salon').setDescription('Salon à activer').setRequired(true).addChannelTypes(ChannelType.GuildText)))
    .addSubcommand(s => s.setName('channel-remove').setDescription('Désactiver l\'IA dans un salon')
      .addChannelOption(o => o.setName('salon').setDescription('Salon à désactiver').setRequired(true).addChannelTypes(ChannelType.GuildText)))
    .addSubcommand(s => s.setName('list').setDescription('Voir les salons où l\'IA est active'))
    .addSubcommand(s => s.setName('persona').setDescription('(Staff) Changer la personnalité de l\'IA')
      .addStringOption(o => o.setName('texte').setDescription('Instruction de personnalité (vide = remettre par défaut)').setMaxLength(300)))
    .addSubcommand(s => s.setName('reset').setDescription('Réinitialiser l\'historique de conversation'))
    .setDMPermission(false)
    .toJSON(),
];

commands.push(...economy.commands, ...perms.commands, ...constructionCmds.commands, ...trade.commands, ...bf.commands);
perms.setCommandNames(commands.map(c => c.name));

const ownerCommands = [new SlashCommandBuilder().setName('diag').setDescription('Diagnostics').toJSON()];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log(`Registering ${commands.length + ownerCommands.length} commands...`);
    await rest.put(Routes.applicationCommands(process.env.DISCORD_APPLICATION_ID), { body: [...commands, ...ownerCommands] });
    console.log('[OK] Commands registered');
  } catch (error) {
    console.error('Command registration error:', error);
  }
}

async function executeModAction({ guild, actorMember, action, user_id, reason, duration }) {
  const target = await guild.members.fetch(user_id).catch(() => null);
  if (!target) return { error: 'User not found' };
  try {
    if (action === 'kick') { await target.kick(reason); return { message: `${target.user.username} kicked` }; }
    if (action === 'ban') { await guild.bans.create(user_id, { reason }); return { message: `${target.user.username} banned` }; }
    if (action === 'timeout') { await target.timeout({ '1h': 3600000, '24h': 86400000, '7d': 604800000 }[duration] || 3600000, reason); return { message: `${target.user.username} timed out for ${duration}` }; }
    return { error: 'Unknown action' };
  } catch (e) {
    return { error: e.message };
  }
}

async function routeSelect(interaction, guild, g) {
  if (interaction.customId.startsWith('delete_confirm_')) {
    const ids = interaction.customId.slice('delete_confirm_'.length).split(',');
    let deleted = 0;
    for (const chId of ids) {
      const ch = guild.channels.cache.get(chId);
      if (ch && ch.deletable) { await ch.delete('Deleted by ' + interaction.user.tag).catch(() => {}); deleted++; }
    }
    await interaction.update({ content: `[OK] ${deleted} channel(s) deleted.`, embeds: [], components: [] });
    return;
  }
  if (interaction.customId.startsWith('delete_cancel_')) { await interaction.update({ content: '[CANCEL]', embeds: [], components: [] }); return; }
  if (interaction.isStringSelectMenu() && interaction.customId === 'delete_select_channels') {
    await constructionCmds.handleSelectMenu(interaction, client, g, db);
    return;
  }
  if (interaction.isButton() && !interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => {});
  }
}

async function handleModCommand(interaction, guild, g) {
  const { commandName } = interaction;
  if (commandName === 'warn') { const target = interaction.options.getUser('user'); await interaction.editReply('[OK] Warned ' + target.username); return; }
  if (['kick', 'ban', 'timeout'].includes(commandName)) { const target = interaction.options.getUser('user'); const reason = interaction.options.getString('raison') || 'No reason'; const res = await executeModAction({ guild, actorMember: interaction.member, action: commandName, user_id: target.id, reason, duration: commandName === 'timeout' ? '1h' : undefined }); await interaction.editReply(res.error ? `[ERROR] ${res.error}` : `[OK] ${res.message}`); return; }
  if (commandName === 'warnings') { await interaction.editReply('[INFO] No warnings'); return; }
  if (commandName === 'modlogs') { await interaction.editReply('[INFO] No logs'); return; }
  if (commandName === 'help') { const embed = new EmbedBuilder().setTitle('Commands').setDescription('Help').setColor(0xFF0000); await interaction.editReply({ embeds: [embed] }); return; }
}

// ===== HANDLER COMMANDE /ai =====
async function handleAiCommand(interaction, guild, g) {
  const sub = interaction.options.getSubcommand();

  // reset : pas besoin d'être staff
  if (sub === 'reset') {
    ai.resetHistory(interaction.channelId, interaction.user.id);
    await interaction.reply({ content: '✅ Historique de conversation réinitialisé.', flags: MessageFlags.Ephemeral });
    return;
  }

  // list : visible par tous
  if (sub === 'list') {
    const channels = (g.aiChannels || []);
    if (!channels.length) {
      await interaction.reply({ content: "ℹ️ L'IA n'est active dans aucun salon (elle répond quand même aux mentions).", flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: `📋 Salons avec IA active :\n${channels.map(id => `<#${id}>`).join('\n')}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  // channel-add / channel-remove / persona : staff uniquement
  if (!perms.canUseCommand(interaction.member, g, 'ai')) {
    await interaction.reply({ content: '❌ Tu n\'as pas la permission d\'utiliser cette commande.', flags: MessageFlags.Ephemeral });
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
    await interaction.editReply(`✅ L'IA est maintenant active dans <#${channel.id}> (répond à tous les messages).`);
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
    await interaction.editReply(`✅ L'IA est désactivée dans <#${channel.id}>.`);
    return;
  }

  if (sub === 'persona') {
    const texte = interaction.options.getString('texte') || null;
    g.aiPersona = texte;
    await db.save(guild.id);
    await interaction.editReply(texte ? `✅ Personnalité de l'IA mise à jour.` : `✅ Personnalité de l'IA remise par défaut.`);
    return;
  }
}
// ================================

async function handleCommand(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  const g = await getGuildConfig(guild.id);

  if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
    await routeSelect(interaction, guild, g);
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'deobf') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply('[INFO] Deobfuscation not implemented');
    return;
  }

  if (bf.isBFCommand(interaction.commandName)) { await bf.handleCommand(interaction); return; }
  if (economy.isEconomyCommand(interaction.commandName)) { await economy.handleCommand(interaction); return; }
  if (trade.isTradeCommand(interaction.commandName)) { await trade.handleCommand(interaction); return; }

  // ===== ROUTING PERMS AJOUTÉ =====
  if (perms.isPermCommand(interaction.commandName)) {
    await perms.handleCommand(interaction);
    return;
  }
  // ================================

  // ===== ROUTING /ai AJOUTÉ =====
  if (interaction.commandName === 'ai') {
    await handleAiCommand(interaction, guild, g);
    return;
  }
  // ==============================

  if (constructionCmds.isConstructionCommand(interaction.commandName)) {
    if (!perms.canUseCommand(interaction.member, g, interaction.commandName)) {
      await interaction.reply({ content: 'No permission', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: ['buildmode', 'copychannels'].includes(interaction.commandName) ? MessageFlags.Ephemeral : undefined });
    await constructionCmds.handleCommand(interaction, client, g, db);
    return;
  }

  if (interaction.commandName === 'ask') {
    await interaction.deferReply();
    const question = interaction.options.getString('question');
    const res = await ai.askClaude({ channelId: interaction.channelId, userId: interaction.user.id, userName: interaction.user.username, userText: question, persona: g.aiPersona, serverContext: needsServerContext(question) ? buildServerContext(guild) : null, speakerInfo: buildSpeakerInfo(interaction.member), guild, canModerate: perms.hasStaff(interaction.member, g) });
    await interaction.editReply(res.error ? `[ERROR] ${res.error}` : res.text);
    return;
  }

  const nonStaffAllowed = new Set(['warnings', 'help']);
  if (!nonStaffAllowed.has(interaction.commandName) && !perms.canUseCommand(interaction.member, g, interaction.commandName)) {
    await interaction.reply({ content: 'No permission', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: ['warnings', 'modlogs', 'case', 'staffrole', 'warnactions', 'automod', 'help', 'setmodlog', 'vider', 'scanalts'].includes(interaction.commandName) ? MessageFlags.Ephemeral : undefined });
  await handleModCommand(interaction, guild, g);
}

client.on(Events.InteractionCreate, async (interaction) => {
  console.log('[INTERACTION]', interaction.type, interaction.commandName || interaction.customId || '');
  try {
    if (interaction.isAutocomplete()) { if (perms.isPermCommand(interaction.commandName)) await perms.autocomplete(interaction); else if (trade.isTradeCommand(interaction.commandName)) await trade.autocomplete(interaction); else if (bf.isBFCommand(interaction.commandName)) await bf.autocomplete(interaction); else await economy.autocomplete(interaction); return; }
    if (interaction.customId && interaction.customId.startsWith('eco:')) { await economy.handleComponent(interaction); return; }
    if (interaction.customId && interaction.customId.startsWith('trade:')) { await trade.handleComponent(interaction); return; }
    if (interaction.customId && interaction.customId.startsWith('bf:')) { await bf.handleComponent(interaction); return; }
    await handleCommand(interaction);
  } catch (error) {
    console.error('Interaction error:', error);
    if (interaction.deferred || interaction.replied) { await interaction.editReply({ content: `[ERROR] ${error.message}` }).catch(() => {}); }
    else { await interaction.reply({ content: `[ERROR] ${error.message}`, flags: MessageFlags.Ephemeral }).catch(() => {}); }
  }
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot || message.author.id === client.user.id) return;
    await dbReadyPromise;
    const guild = message.guild;
    if (!guild) return;
    const g = await getGuildConfig(guild.id);
    await automod.checkMessage(message, client, g, db);

    // ===== RÉPONSE IA DANS LES SALONS CONFIGURÉS =====
    if (g.aiEnabled !== false && Array.isArray(g.aiChannels) && g.aiChannels.includes(message.channelId)) {
      const res = await ai.askClaude({
        channelId: message.channelId,
        userId: message.author.id,
        userName: message.author.username,
        userText: message.content,
        persona: g.aiPersona,
        serverContext: needsServerContext(message.content) ? buildServerContext(guild) : null,
        speakerInfo: `${message.author.username} (no slash command)`,
        guild,
        canModerate: false,
      });
      if (res.text) message.reply({ content: res.text, allowedMentions: { repliedUser: false } }).catch(() => {});
    }
    // ==================================================
  } catch (error) {
    console.error('Message error:', error);
  }
});

client.on(Events.GuildCreate, async (guild) => {
  console.log(`Joined: ${guild.name}`);
  await getGuildConfig(guild.id);
});

client.once(Events.ClientReady, async () => {
  console.log(`Connected as ${client.user.tag}`);
  await registerCommands();
  await dbReadyPromise.catch(e => console.error('DB init failed:', e));
  console.log(`${client.guilds.cache.size} server(s)`);
  economy.startVoiceTracking(client);
});

console.log('[BOOT] login en cours...');
client.login(process.env.DISCORD_TOKEN)
  .then(() => console.log('[BOOT] login OK'))
  .catch(err => console.error('[BOOT] LOGIN FAILED:', err.message));
