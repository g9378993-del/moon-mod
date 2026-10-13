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
const { Client, GatewayIntentBits, Partials, Events, PermissionFlagsBits, ChannelType, EmbedBuilder, REST, Routes, SlashCommandBuilder, AttachmentBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

const http = require('http');
http.createServer((req, res) => res.end('OK')).listen(process.env.PORT || 3000);

const INSTANCE_ID = `moon-${Date.now()}`;
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.DirectMessages], partials: [Partials.Channel, Partials.Message] });
let dbReadyPromise = db.initDb();

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

const commands = [new SlashCommandBuilder().setName('ask').setDescription('Ask AI').addStringOption(o => o.setName('question').setDescription('Question').setRequired(true)).setDMPermission(false).toJSON(), new SlashCommandBuilder().setName('deobf').setDescription('Deobfuscate script').addAttachmentOption(o => o.setName('fichier').setDescription('File').setRequired(true)).setDMPermission(false).toJSON(), new SlashCommandBuilder().setName('help').setDescription('Show commands').setDMPermission(false).toJSON()];

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
    const chId = interaction.customId.split('_')[2];
    const ch = guild.channels.cache.get(chId);
    if (ch && ch.deletable) { await ch.delete('Deleted by ' + interaction.user.tag).catch(() => {}); await interaction.update({ content: '[OK] Deleted', embeds: [], components: [] }); }
    else { await interaction.update({ content: '[ERROR] Cannot delete', embeds: [], components: [] }); }
    return;
  }
  if (interaction.customId.startsWith('delete_cancel_')) { await interaction.update({ content: '[CANCEL]', embeds: [], components: [] }); return; }
  if (interaction.isStringSelectMenu() && interaction.customId === 'delete_select_channels') {
    await constructionCmds.handleSelectMenu(interaction, client, g, db);
    return;
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

async function handleCommand(interaction) {
  const guild = interaction.guild;
  const g = await db.get(guild.id);

  if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
    await routeSelect(interaction, guild, g);
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'deobf') {
    await interaction.deferReply({ ephemeral: true });
    await interaction.editReply('[INFO] Deobfuscation not implemented');
    return;
  }

  if (bf.isBFCommand(interaction.commandName)) { await bf.handleCommand(interaction); return; }
  if (economy.isEconomyCommand(interaction.commandName)) { await economy.handleCommand(interaction); return; }
  if (trade.isTradeCommand(interaction.commandName)) { await trade.handleCommand(interaction); return; }

  if (constructionCmds.isConstructionCommand(interaction.commandName)) {
    if (!perms.canUseCommand(interaction.member, g, interaction.commandName)) {
      await interaction.reply({ content: 'No permission', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: ['buildmode', 'copychannels'].includes(interaction.commandName) });
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
    await interaction.reply({ content: 'No permission', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: ['warnings', 'modlogs', 'case', 'staffrole', 'warnactions', 'automod', 'help', 'setmodlog', 'vider', 'scanalts'].includes(interaction.commandName) });
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
    console.error('Interaction error:', error);
    if (interaction.deferred || interaction.replied) { await interaction.editReply({ content: `[ERROR] ${error.message}`, ephemeral: true }).catch(() => {}); }
    else { await interaction.reply({ content: `[ERROR] ${error.message}`, ephemeral: true }).catch(() => {}); }
  }
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot || message.author.id === client.user.id) return;
    await dbReadyPromise;
    const guild = message.guild;
    if (!guild) return;
    const g = await db.get(guild.id);
    await automod.checkMessage(message, client, g, db);
  } catch (error) {
    console.error('Message error:', error);
  }
});

client.on(Events.GuildCreate, async (guild) => {
  console.log(`Joined: ${guild.name}`);
  await db.get(guild.id);
});

client.once(Events.ClientReady, async () => {
  console.log(`Connected as ${client.user.tag}`);
  await dbReadyPromise;
  console.log(`${client.guilds.cache.size} server(s)`);
  await registerCommands();
  economy.startVoiceTracking(client);
});

client.login(process.env.DISCORD_TOKEN);
