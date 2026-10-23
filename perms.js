// ================================================================
// perms.js — Permissions par commande
//  • /permuser  : choisir quels membres peuvent utiliser quelles commandes
//  • /staffrole : pareil mais pour un rôle
//  Sans commande précisée = TOUTES les commandes (accès staff complet).
//
// Données (dans g, donc même base que le reste) :
//  g.staffRoles          : [roleId]            → rôles avec accès à tout (déjà existant)
//  g.permRoles[roleId]   : { all, cmds: [] }   → rôles avec accès à certaines commandes
//  g.permUsers[userId]   : { all, cmds: [] }   → membres avec accès à certaines commandes
// ================================================================
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const db = require('./db');
const mod = require('./moderation');

// On ne peut pas déléguer la gestion des permissions elle-même.
const PROTECTED = new Set(['permuser', 'staffrole']);
let commandNames = [];
function setCommandNames(names) { commandNames = [...new Set(names)].filter((n) => !PROTECTED.has(n)).sort(); }

// Injecté depuis index.js après initialisation pour éviter la dépendance circulaire.
let _syncCommandPerms = null;
function setSyncFn(fn) { _syncCommandPerms = fn; }
async function syncPerms(guild) { if (_syncCommandPerms) await _syncCommandPerms(guild).catch(() => {}); }

// Envoie un MP au membre pour lui expliquer comment activer la commande dans Discord.
async function sendPermDM(client, userId, guildName, cmdNames) {
  try {
    const user = await client.users.fetch(userId);
    const list = cmdNames.map(c => `\`/${c}\``).join(', ');
    const steps = [
      `1. Ouvre **${guildName}** sur Discord`,
      `2. Clique sur le nom du serveur (en haut à gauche) → **Paramètres du serveur**`,
      `3. Va dans **Intégrations** → trouve le bot **Moon Manager**`,
      `4. Dans la liste des commandes, active ${list}`,
      `5. Clique **Enregistrer** — la commande apparaît maintenant dans ton menu /`,
    ].join('\n');
    await user.send(`✅ Tu as reçu l'accès à ${list} sur **${guildName}**.\n\nPour que la commande apparaisse dans ton menu \`/\`, suis ces étapes :\n${steps}`);
  } catch (e) { /* MP fermés, tant pis */ }
}

let _discordClient = null;
function setClient(c) { _discordClient = c; }

function ensure(g) {
  if (!g.permUsers || typeof g.permUsers !== 'object') g.permUsers = {};
  if (!g.permRoles || typeof g.permRoles !== 'object') g.permRoles = {};
  if (!Array.isArray(g.staffRoles)) g.staffRoles = [];
}

// ----------------------------------------------------------------
// VÉRIFICATIONS
// ----------------------------------------------------------------
// "Base" : Administrateur / Gérer le serveur / propriétaire / rôle ajouté
// via /staffrole SANS commande. On lit g.staffRoles directement (au lieu de
// dépendre uniquement de moderation.js) pour que /staffrole marche à coup sûr.
function hasBase(member, g) {
  if (!member) return false;
  try { if (mod.hasModPerms(member, g)) return true; } catch { /* on continue avec notre propre vérif */ }
  try {
    if (member.guild && member.guild.ownerId === member.id) return true;
    if (member.permissions && (member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageGuild))) return true;
    const staff = Array.isArray(g.staffRoles) ? g.staffRoles : [];
    return member.roles.cache.some((r) => staff.includes(r.id));
  } catch { return false; }
}
const grantAll = (gr) => !!gr && !!gr.all;
const grantHas = (gr, cmd) => !!gr && (!!gr.all || (Array.isArray(gr.cmds) && gr.cmds.includes(cmd)));

// Accès à TOUT (= staff complet) : base, ou "tout" donné via /permuser ou /staffrole.
function hasStaff(member, g) {
  if (!member) return false;
  if (hasBase(member, g)) return true;
  ensure(g);
  if (grantAll(g.permUsers[member.id])) return true;
  return member.roles.cache.some((r) => grantAll(g.permRoles[r.id]));
}
// Accès à UNE commande précise.
function canUseCommand(member, g, cmd) {
  if (!member) return false;
  ensure(g);
  if (hasStaff(member, g)) return true;
  if (grantHas(g.permUsers[member.id], cmd)) return true;
  return member.roles.cache.some((r) => grantHas(g.permRoles[r.id], cmd));
}

// ----------------------------------------------------------------
// COMMANDES
// ----------------------------------------------------------------
const cmdOpt = (o) => o.setName('commande').setDescription('Commande concernée (vide = TOUTES les commandes)').setAutocomplete(true);
const commands = [
  new SlashCommandBuilder().setName('permuser').setDescription('Choisir quels membres peuvent utiliser quelles commandes (vide = tout)')
    .addSubcommand((s) => s.setName('add').setDescription('Autoriser un membre')
      .addUserOption((o) => o.setName('utilisateur').setDescription('Le membre').setRequired(true))
      .addStringOption(cmdOpt))
    .addSubcommand((s) => s.setName('remove').setDescription('Retirer une autorisation')
      .addUserOption((o) => o.setName('utilisateur').setDescription('Le membre').setRequired(true))
      .addStringOption(cmdOpt))
    .addSubcommand((s) => s.setName('list').setDescription('Voir les membres autorisés')),

  new SlashCommandBuilder().setName('staffrole').setDescription('Choisir quels rôles peuvent utiliser quelles commandes (vide = tout)')
    .addSubcommand((s) => s.setName('add').setDescription('Autoriser un rôle')
      .addRoleOption((o) => o.setName('role').setDescription('Le rôle').setRequired(true))
      .addStringOption(cmdOpt))
    .addSubcommand((s) => s.setName('remove').setDescription('Retirer une autorisation')
      .addRoleOption((o) => o.setName('role').setDescription('Le rôle').setRequired(true))
      .addStringOption(cmdOpt))
    .addSubcommand((s) => s.setName('list').setDescription('Voir les rôles autorisés')),
].map((c) => c.setDMPermission(false).toJSON());

const isPermCommand = (name) => PROTECTED.has(name);

async function autocomplete(interaction) {
  const q = interaction.options.getFocused().toLowerCase().replace(/^\//, '');
  const choices = commandNames.filter((n) => n.includes(q)).slice(0, 25).map((n) => ({ name: `/${n}`, value: n }));
  await interaction.respond(choices).catch(() => {});
}

const fmtGrant = (gr) => (gr.all ? '**toutes les commandes**' : gr.cmds.map((c) => `\`/${c}\``).join(', '));

// Ajoute une autorisation à store[id] : sans commande = "tout", sinon cette commande.
function grantAdd(store, id, cmd) {
  const gr = store[id] || (store[id] = { all: false, cmds: [] });
  if (!Array.isArray(gr.cmds)) gr.cmds = [];
  if (!cmd) gr.all = true;
  else if (!gr.cmds.includes(cmd)) gr.cmds.push(cmd);
  return gr;
}
// Retire : sans commande = tout supprimer. Renvoie un code pour le message.
function grantRemove(store, id, cmd) {
  const gr = store[id];
  if (!gr) return 'none';
  if (!cmd) { delete store[id]; return 'all'; }
  if (gr.all) return 'is_all';
  if (!gr.cmds.includes(cmd)) return 'missing';
  gr.cmds = gr.cmds.filter((c) => c !== cmd);
  if (!gr.cmds.length) delete store[id];
  return 'cmd';
}

async function handleCommand(interaction) {
  const guild = interaction.guild;
  const g = db.get(guild.id);
  const needsInit = !g.permUsers || !g.permRoles;
  ensure(g);
  // Si les champs n'existaient pas encore en DB, on les persiste tout de suite
  // pour éviter que des modifications ultérieures écrasent un objet undefined.
  if (needsInit) await db.save(guild.id).catch(() => {});
  if (!hasBase(interaction.member, g)) {
    await interaction.reply({ content: '❌ Seuls les Administrateurs / Gérer le serveur / rôles staff (accès complet) peuvent gérer les permissions.', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const reply = (content) => interaction.editReply({ content, allowedMentions: { parse: [] } });
  const name = interaction.commandName;
  const sub = interaction.options.getSubcommand();
  const rawCmd = interaction.options.getString('commande');
  const cmd = rawCmd ? rawCmd.trim().replace(/^\//, '').toLowerCase() : null;
  if (cmd && !commandNames.includes(cmd)) { await reply(`❌ Commande inconnue : \`${cmd}\`. Choisis-en une dans la liste proposée (ou laisse vide pour toutes).`); return; }
  const what = cmd ? `\`/${cmd}\`` : '**toutes les commandes**';

  // ------------------------- /permuser -------------------------
  if (name === 'permuser') {
    if (sub === 'list') {
      const lines = Object.entries(g.permUsers).map(([id, gr]) => `<@${id}> — ${fmtGrant(gr)}`);
      await reply(lines.length ? `👤 **Membres autorisés**\n${lines.join('\n')}` : '👤 Aucun membre avec une permission spéciale.\n(Administrateur, Gérer le serveur et les rôles ajoutés via `/staffrole` ont déjà accès.)');
      return;
    }
    const user = interaction.options.getUser('utilisateur');
    if (sub === 'add') {
      if (user.bot) { await reply('❌ Impossible pour un bot.'); return; }
      grantAdd(g.permUsers, user.id, cmd);
      await db.save(guild.id);
      await syncPerms(guild);
      await reply(`✅ <@${user.id}> peut maintenant utiliser ${what}.`);
      return;
    }
    const r = grantRemove(g.permUsers, user.id, cmd);
    if (r === 'none') { await reply('❌ Ce membre n\'a aucune permission spéciale.'); return; }
    if (r === 'is_all') { await reply(`❌ <@${user.id}> a accès à **toutes** les commandes. Pour lui retirer, lance \`/permuser remove\` **sans** préciser de commande.`); return; }
    if (r === 'missing') { await reply(`❌ <@${user.id}> n'avait pas accès à ${what}.`); return; }
    await db.save(guild.id);
    await syncPerms(guild);
    await reply(`✅ <@${user.id}> ne peut plus utiliser ${r === 'all' ? '**aucune commande spéciale**' : what}.`);
    return;
  }

  // ------------------------- /staffrole -------------------------
  if (sub === 'list') {
    const lines = g.staffRoles.map((id) => `<@&${id}> — **toutes les commandes**`);
    for (const [id, gr] of Object.entries(g.permRoles)) if (!g.staffRoles.includes(id)) lines.push(`<@&${id}> — ${fmtGrant(gr)}`);
    await reply(lines.length ? `🎭 **Rôles autorisés**\n${lines.join('\n')}` : '🎭 Aucun rôle autorisé (Administrateur / Gérer le serveur uniquement).');
    return;
  }
  const role = interaction.options.getRole('role');
  if (sub === 'add') {
    if (role.id === guild.id) { await reply('❌ Impossible avec @everyone.'); return; }
    if (!cmd) { if (!g.staffRoles.includes(role.id)) g.staffRoles.push(role.id); }
    else grantAdd(g.permRoles, role.id, cmd);
    await db.save(guild.id);
    await syncPerms(guild);
    await reply(`✅ <@&${role.id}> peut maintenant utiliser ${what}.`);
    return;
  }
  // remove
  if (!cmd) {
    const had = g.staffRoles.includes(role.id) || !!g.permRoles[role.id];
    g.staffRoles = g.staffRoles.filter((r) => r !== role.id);
    delete g.permRoles[role.id];
    if (!had) { await reply('❌ Ce rôle n\'avait aucune permission spéciale.'); return; }
    await db.save(guild.id);
    await syncPerms(guild);
    await reply(`✅ <@&${role.id}> n'a plus aucune permission spéciale.`);
    return;
  }
  if (g.staffRoles.includes(role.id)) { await reply(`❌ <@&${role.id}> a accès à **toutes** les commandes. Pour lui retirer, lance \`/staffrole remove\` **sans** préciser de commande.`); return; }
  const r = grantRemove(g.permRoles, role.id, cmd);
  if (r === 'none') { await reply('❌ Ce rôle n\'a aucune permission spéciale.'); return; }
  if (r === 'missing') { await reply(`❌ <@&${role.id}> n'avait pas accès à ${what}.`); return; }
  await db.save(guild.id);
  await syncPerms(guild);
  await reply(`✅ <@&${role.id}> ne peut plus utiliser ${what}.`);
}

module.exports = { commands, isPermCommand, handleCommand, autocomplete, setCommandNames, setSyncFn, setClient, hasStaff, canUseCommand, hasBase };
