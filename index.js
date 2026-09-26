require('dotenv').config();
const crypto = require('crypto');
const db = require('./db');
const mod = require('./moderation');
const automod = require('./automod');
const ai = require('./ai');
const {
  Client, GatewayIntentBits, Partials, Events, PermissionFlagsBits, ChannelType,
  EmbedBuilder, REST, Routes, SlashCommandBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder,
} = require('discord.js');

process.on('unhandledRejection', (err) => console.error('Promesse rejetée non gérée :', err));
process.on('uncaughtException', (err) => console.error('Exception non gérée :', err));

// ----------------------------------------------------------------
// CONTEXTE SERVEUR POUR L'IA (salons + rôles), pour orienter les membres
// ----------------------------------------------------------------
// Reconstruit à chaque appel (pas de cache) : les salons/rôles peuvent
// changer entre deux messages, et c'est rapide (cache local de discord.js).
function buildServerContext(guild, member, otherMembers = []) {
  // Liste COMPLÈTE (pas de troncature) : salons visibles par la personne qui
  // parle au bot, avec leur ID. Si `member` est fourni, on filtre selon ses
  // permissions réelles (ViewChannel) pour que l'IA ne propose jamais un
  // salon privé/staff à quelqu'un qui n'y a pas accès.
  const channels = guild.channels.cache
    .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
    .filter((c) => !member || c.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel))
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map((c) => `#${c.name} — id:${c.id} (<#${c.id}>)${c.topic ? ` — ${c.topic.slice(0, 80)}` : ''}`);

  // Liste COMPLÈTE de tous les rôles du serveur, avec leur ID.
  const roles = guild.roles.cache
    .filter((r) => r.id !== guild.id && !r.managed) // pas @everyone, pas les rôles de bots
    .sort((a, b) => b.position - a.position)
    .map((r) => `@${r.name} — id:${r.id} (<@&${r.id}>)`);

  const rolesOf = (m) => guild.roles.cache
    .filter((r) => r.id !== guild.id && m.roles.cache.has(r.id))
    .sort((a, b) => b.position - a.position)
    .map((r) => `@${r.name} (id:${r.id})`);

  // Rôle(s) de la personne qui parle actuellement au bot, du plus haut au plus bas.
  const memberRoles = member ? rolesOf(member) : [];

  // Rôle(s) de toute personne @mentionnée dans le message (pour répondre à
  // "quel rôle a untel ?" même si ce n'est pas la personne qui parle).
  const mentionedLines = otherMembers
    .filter((m) => !member || m.id !== member.id)
    .map((m) => `${m.user.tag} : ${rolesOf(m).join(', ') || 'aucun rôle particulier'}`);

  return [
    member
      ? `Rôle(s) de LA PERSONNE QUI TE PARLE actuellement : ${memberRoles.join(', ') || 'aucun rôle particulier (membre de base)'}. Son rôle le plus élevé : ${memberRoles[0] || 'aucun'}.`
      : '',
    mentionedLines.length
      ? `Rôle(s) d'autres personnes reconnues dans ce message (par @mention ou par pseudo cité) :\n${mentionedLines.join('\n')}`
      : '',
    `Salons textuels que CETTE personne peut voir (liste complète) :\n${channels.join('\n') || 'aucun'}`,
    `Tous les rôles du serveur (liste complète) :\n${roles.join('\n') || 'aucun'}`,
  ].filter(Boolean).join('\n\n');
}

// Petits mots vides à ignorer quand on cherche un nom de personne dans une
// phrase (sinon "le", "salon", "rôle"... seraient tentés comme des pseudos).
const NAME_STOPWORDS = new Set(['les','des','une','que','qui','quoi','pour','avec','dans','sur','est','sont','elle','cette','ces','son','ses','mon','mes','ton','tes','notre','nos','votre','vos','leur','leurs','quel','quelle','quels','quelles','rôle','role','roles','rôles','salon','salons','discord','bot','avoir','fait','faire','être','etre','alors','donc','comme','bien','très','tres','ici','nous','vous','ils','elles']);

// Cherche, dans un texte libre, un membre cité par son pseudo/pseudonyme SANS
// @mention (ex: "c'est quoi le rôle de Kevin ?"). Recherche par mots du
// message via l'API de recherche de membres Discord, en ne gardant que les
// correspondances EXACTES (pas de préfixe) pour éviter les faux positifs.
async function resolveMembersByName(guild, text, excludeIds = []) {
  const tokens = [...new Set((text.match(/[\p{L}][\p{L}'-]{1,}/gu) || [])
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 3 && !NAME_STOPWORDS.has(t)))].slice(0, 6);
  if (!tokens.length) return [];

  const results = await Promise.all(tokens.map((t) => guild.members.search({ query: t, limit: 3 }).catch(() => null)));
  const found = new Map();
  results.forEach((col, i) => {
    if (!col) return;
    const token = tokens[i];
    for (const m of col.values()) {
      if (excludeIds.includes(m.id) || found.has(m.id)) continue;
      const candidates = [m.user.username, m.user.globalName, m.nickname].filter(Boolean).map((s) => s.toLowerCase());
      if (candidates.includes(token)) found.set(m.id, m);
    }
  });
  return [...found.values()];
}

const INSTANCE_ID = crypto.randomBytes(2).toString('hex');
const STARTED_AT = Date.now();
const dup = { count: 0, lastAt: null };
const isBotOwner = (userId) => !!process.env.OWNER_ID && userId === process.env.OWNER_ID;

// ----------------------------------------------------------------
// LOGS DEMANDÉS EN PARLANT AU BOT ("montre les logs", "logs du rôle X"...)
// ----------------------------------------------------------------
const LOGS_REGEX = /\blogs?\b/i;
const CASE_TITLES = {
  kick: 'Kick', ban: 'Ban', unban: 'Unban', warn: 'Avertissement', timeout: 'Timeout', untimeout: 'Fin de timeout',
  'automod-delete': 'Automod (suppression)', 'automod-timeout': 'Automod (timeout)', raid: 'Anti-raid',
};

// Cherche un rôle cité dans le texte (par @mention ou par son nom exact),
// pour filtrer les logs sur ce rôle. Les noms les plus longs sont testés en
// premier pour éviter qu'un rôle court (ex: "VIP") ne matche à tort à
// l'intérieur d'un nom plus long.
function findRoleInText(guild, text) {
  const mention = text.match(/<@&(\d+)>/);
  if (mention) { const r = guild.roles.cache.get(mention[1]); if (r) return r; }
  const roles = [...guild.roles.cache.values()]
    .filter((r) => r.id !== guild.id && !r.managed && r.name.length >= 2)
    .sort((a, b) => b.name.length - a.name.length);
  for (const r of roles) {
    const re = new RegExp(`\\b${r.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(text)) return r;
  }
  return null;
}

// Gère les demandes de logs faites EN PARLANT au bot ("montre-moi les logs",
// "les logs du rôle Staff"...). Renvoie null si ce n'est pas une demande de
// logs (le message continue normalement vers l'IA). Sinon renvoie le texte à
// répondre DIRECTEMENT, sans passer par Gemini — l'accès est TOUJOURS
// vérifié via hasModPerms (même check que les commandes de modération), donc
// ça ne marche jamais pour n'importe qui, seulement pour le staff.
async function handleLogsIntent({ guild, member, g, text }) {
  if (!LOGS_REGEX.test(text)) return null;
  if (!mod.hasModPerms(member, g)) return '❌ Seul le staff peut consulter les logs de modération.';

  const role = findRoleInText(guild, text);
  let cases = g.cases || [];

  if (role) {
    let roleMembers = role.members; // cache
    try { await guild.members.fetch(); roleMembers = role.members; } catch (e) { /* on garde le cache si le fetch échoue */ }
    const ids = new Set(roleMembers.map((m) => m.id));
    cases = cases.filter((c) => ids.has(c.userId));
    if (!cases.length) return `📋 Aucun log trouvé pour des membres ayant le rôle <@&${role.id}>.`;
  }

  const recent = [...cases].sort((a, b) => b.createdAt - a.createdAt).slice(0, 15);
  const lines = recent.map((c) => `#${c.id} • **${CASE_TITLES[c.type] || c.type}** • <@${c.userId}> • <t:${Math.floor(c.createdAt / 1000)}:R>${c.reason ? ` — ${c.reason}` : ''}`);
  const header = role ? `📋 Derniers logs pour le rôle <@&${role.id}> (${cases.length} au total) :` : `📋 Derniers logs (${cases.length} au total) :`;
  return `${header}\n${lines.join('\n')}`;
}

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
    .addSubcommand((s) => s.setName('grosmots').setDescription('Filtre intégré multilingue (FR/EN/ES/DE/IT/PT) qui supprime les gros mots')
      .addStringOption((o) => o.setName('etat').setDescription('on/off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })))
    .addSubcommand((s) => s.setName('antiraid').setDescription('Anti-raid (afflux anormal de nouveaux membres)')
      .addStringOption((o) => o.setName('etat').setDescription('on/off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }))
      .addIntegerOption((o) => o.setName('seuil').setDescription("Nb d'arrivées déclenchant l'alerte"))
      .addIntegerOption((o) => o.setName('fenetre_secondes').setDescription('Fenêtre en secondes'))
      .addIntegerOption((o) => o.setName('age_min_jours').setDescription('Âge de compte minimum jugé "sûr" (jours)'))
      .addStringOption((o) => o.setName('action').setDescription('Action sur les comptes suspects').addChoices({ name: 'Timeout 30 min', value: 'timeout' }, { name: 'Kick', value: 'kick' }, { name: 'Alerte seulement', value: 'alert_only' }))),

  new SlashCommandBuilder().setName('ai').setDescription('Configurer le chat IA du bot')
    .addSubcommand((s) => s.setName('channel-add').setDescription('Le bot répondra à TOUS les messages de ce salon').addChannelOption((o) => o.setName('salon').setDescription('Le salon').setRequired(true)))
    .addSubcommand((s) => s.setName('channel-remove').setDescription('Retirer un salon de discussion IA').addChannelOption((o) => o.setName('salon').setDescription('Le salon').setRequired(true)))
    .addSubcommand((s) => s.setName('channel-list').setDescription('Voir les salons de discussion IA'))
    .addSubcommand((s) => s.setName('toggle').setDescription('Activer/désactiver la réponse quand le bot est mentionné').addStringOption((o) => o.setName('etat').setDescription('on/off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })))
    .addSubcommand((s) => s.setName('persona').setDescription('Personnalité/ton donné au bot').addStringOption((o) => o.setName('texte').setDescription('Ex: "réponds de façon très courte et fun"').setRequired(true)))
    .addSubcommand((s) => s.setName('reset').setDescription('Oublier ta conversation en cours avec le bot dans ce salon')),

  new SlashCommandBuilder().setName('ask').setDescription("Poser une question à l'IA (répond dans ta langue)")
    .addStringOption((o) => o.setName('question').setDescription('Ta question').setRequired(true)),

  new SlashCommandBuilder().setName('language').setDescription("Définir la langue principale utilisée par l'IA sur ce serveur")
    .addSubcommand((s) => s.setName('set').setDescription('Changer la langue principale')
      .addStringOption((o) => o.setName('langue').setDescription('Ex: français, english, español, العربية...').setRequired(true)))
    .addSubcommand((s) => s.setName('show').setDescription('Voir la langue principale actuelle')),

  new SlashCommandBuilder().setName('permscmnds').setDescription('Autoriser/retirer un rôle sur une commande précise (en plus du staff)')
    .addSubcommand((s) => s.setName('allow').setDescription('Autoriser un rôle à utiliser une commande')
      .addStringOption((o) => o.setName('commande').setDescription('Nom de la commande, ex: kick').setRequired(true))
      .addRoleOption((o) => o.setName('role').setDescription('Le rôle').setRequired(true)))
    .addSubcommand((s) => s.setName('deny').setDescription('Retirer cette autorisation')
      .addStringOption((o) => o.setName('commande').setDescription('Nom de la commande').setRequired(true))
      .addRoleOption((o) => o.setName('role').setDescription('Le rôle').setRequired(true)))
    .addSubcommand((s) => s.setName('list').setDescription('Voir les autorisations par commande')),

  new SlashCommandBuilder().setName('findsalon').setDescription('Chercher un salon par mot-clé (nom ou description)')
    .addStringOption((o) => o.setName('mot').setDescription('Mot-clé à chercher').setRequired(true)),

  new SlashCommandBuilder().setName('ticket').setDescription('Système de tickets de support')
    .addSubcommand((s) => s.setName('setup').setDescription('Configurer le système de tickets')
      .addChannelOption((o) => o.setName('categorie').setDescription('Catégorie où créer les salons de tickets').setRequired(true).addChannelTypes(ChannelType.GuildCategory))
      .addRoleOption((o) => o.setName('role_support').setDescription('Rôle ajouté automatiquement à chaque ticket').setRequired(true))
      .addStringOption((o) => o.setName('message').setDescription("Message d'accueil personnalisé dans chaque ticket")))
    .addSubcommand((s) => s.setName('panel').setDescription('Poster le panneau "Ouvrir un ticket" dans ce salon'))
    .addSubcommand((s) => s.setName('close').setDescription('Fermer le ticket en cours (à utiliser DANS le salon du ticket)'))
    .addSubcommand((s) => s.setName('add').setDescription('Ajouter quelqu\'un au ticket en cours').addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true)))
    .addSubcommand((s) => s.setName('remove').setDescription('Retirer quelqu\'un du ticket en cours').addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true))),

  new SlashCommandBuilder().setName('findsource').setDescription('Chercher les sources (liens/pièces jointes) postées dans un ou plusieurs salons')
    .addChannelOption((o) => o.setName('salon').setDescription('Salon à fouiller').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addChannelOption((o) => o.setName('salon2').setDescription('2e salon (optionnel)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addChannelOption((o) => o.setName('salon3').setDescription('3e salon (optionnel)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addStringOption((o) => o.setName('mot').setDescription('Mot-clé à chercher dans le message (optionnel)'))
    .addUserOption((o) => o.setName('membre').setDescription('Ne garder que les sources de cette personne'))
    .addIntegerOption((o) => o.setName('limite').setDescription('Nb de messages récents à fouiller par salon (défaut 100, max 500)').setMinValue(10).setMaxValue(500)),

  new SlashCommandBuilder().setName('help').setDescription('Voir toutes les commandes')
    .addStringOption((o) => o.setName('langue').setDescription('Forcer une langue précise pour cette réponse (sinon : ta langue connue)')),
].map((c) => c.setDMPermission(false).toJSON());

const ownerCommands = [
  new SlashCommandBuilder().setName('diag').setDescription('(Toi uniquement) État du bot : stockage, doublons, serveurs'),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [...commands, ...ownerCommands] });
    console.log(`Commandes slash enregistrées en global (${commands.length + ownerCommands.length} commandes).`);
  } catch (err) { console.error('Erreur enregistrement des commandes :', err); }
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
// SYSTÈME DE TICKETS — fermeture (transcript envoyé aux logs + suppression
// du salon après un court délai, pour laisser le temps de lire le message).
// ----------------------------------------------------------------
async function closeTicket(guild, channel, g, closedBy) {
  const entry = g.tickets.open[channel.id];
  try {
    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (messages) {
      const lines = [...messages.values()].reverse().map((m) => `[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${m.content || '(sans texte)'}${m.attachments.size ? ` [${m.attachments.size} pièce(s) jointe(s)]` : ''}`);
      if (g.modLogChannelId) {
        const embed = new EmbedBuilder().setColor(mod.COLORS.ticketClose).setTitle(`🔒 Ticket fermé — #${entry?.number ?? '?'}`)
          .addFields(
            { name: 'Ouvert par', value: entry ? `<@${entry.userId}>` : 'inconnu', inline: true },
            { name: 'Fermé par', value: `<@${closedBy.id}>`, inline: true },
            { name: 'Pris en charge par', value: entry?.claimedBy ? `<@${entry.claimedBy}>` : 'personne', inline: true },
          ).setTimestamp();
        await mod.postToModLog(guild.client, g, embed);
        try {
          const logChannel = await guild.client.channels.fetch(g.modLogChannelId);
          const attachment = new AttachmentBuilder(Buffer.from(lines.join('\n') || '(vide)', 'utf8'), { name: `transcript-${channel.name}.txt` });
          await logChannel.send({ files: [attachment] });
        } catch (e) { /* pas de perms d'envoi de fichier, tant pis pour le transcript */ }
      }
    }
  } catch (e) { console.error('Transcript ticket impossible :', e.message); }
  delete g.tickets.open[channel.id];
  await db.save(guild.id);
  try { await channel.send('🔒 Ce ticket va être supprimé dans 5 secondes...'); } catch (e) { /* ignore */ }
  setTimeout(() => { channel.delete('Ticket fermé').catch(() => {}); }, 5000);
}

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
    if (sub === 'grosmots') {
      am.profanity.enabled = interaction.options.getString('etat') === 'on';
      await db.save(guild.id);
      await reply(`✅ Filtre de gros mots intégré (FR/EN/ES/DE/IT/PT) : ${am.profanity.enabled ? 'activé' : 'désactivé'}.`);
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

  if (cmd === 'language') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'show') { await reply(g.aiLanguage ? `🌐 Langue principale actuelle : **${g.aiLanguage}**.` : "🌐 Aucune langue principale définie : le bot répond dans la langue de chaque personne."); return; }
    if (sub === 'set') {
      g.aiLanguage = interaction.options.getString('langue');
      await db.save(guild.id);
      await reply(`✅ Langue principale du bot sur ce serveur : **${g.aiLanguage}**. Il l'utilisera avec tout le monde, sauf avec ceux qui lui parlent (ou lui ont déjà parlé) dans une autre langue : dans ce cas il retient leur langue et continue à leur répondre pareil à chaque fois.`);
      return;
    }
  }

  if (cmd === 'ticket') {
    const sub = interaction.options.getSubcommand();
    const t = g.tickets;

    if (sub === 'setup') {
      if (!mod.hasModPerms(interaction.member, g)) { await reply('❌ Réservé au staff.'); return; }
      const categorie = interaction.options.getChannel('categorie');
      const role = interaction.options.getRole('role_support');
      const message = interaction.options.getString('message');
      t.enabled = true;
      t.categoryId = categorie.id;
      t.supportRoleId = role.id;
      if (message) t.welcomeMessage = message;
      await db.save(guild.id);
      await reply(`✅ Système de tickets configuré : catégorie **${categorie.name}**, rôle support <@&${role.id}>. Poste le panneau avec \`/ticket panel\` dans le salon de ton choix.`);
      return;
    }

    if (sub === 'panel') {
      if (!mod.hasModPerms(interaction.member, g)) { await reply('❌ Réservé au staff.'); return; }
      if (!t.enabled || !t.categoryId) { await reply('❌ Configure d\'abord le système avec `/ticket setup`.'); return; }
      const embed = new EmbedBuilder().setColor(mod.COLORS.ticket).setTitle('🎫 Support — Ouvrir un ticket')
        .setDescription(t.welcomeMessage || "Besoin d'aide ? Clique sur le bouton ci-dessous pour ouvrir un salon privé avec l'équipe.")
        .setThumbnail(guild.iconURL() || null)
        .setFooter({ text: guild.name });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ticket_open').setLabel('Ouvrir un ticket').setEmoji('🎫').setStyle(ButtonStyle.Success),
      );
      const msg = await interaction.channel.send({ embeds: [embed], components: [row] });
      t.panelChannelId = interaction.channelId;
      t.panelMessageId = msg.id;
      await db.save(guild.id);
      await reply('✅ Panneau posté dans ce salon.');
      return;
    }

    // add/remove/close : utilisables DEPUIS le salon du ticket concerné.
    const entry = t.open[interaction.channelId];
    if (!entry) { await reply('❌ Cette commande s\'utilise DANS un salon de ticket.'); return; }

    if (sub === 'add' || sub === 'remove') {
      if (!mod.hasModPerms(interaction.member, g)) { await reply('❌ Réservé au staff.'); return; }
      const membre = interaction.options.getUser('membre');
      try {
        if (sub === 'add') await interaction.channel.permissionOverwrites.edit(membre.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
        else await interaction.channel.permissionOverwrites.delete(membre.id);
      } catch (e) { await reply(`❌ Erreur (${e.message}).`); return; }
      await reply(sub === 'add' ? `✅ ${membre} ajouté au ticket.` : `✅ ${membre} retiré du ticket.`);
      return;
    }

    if (sub === 'close') {
      if (entry.userId !== interaction.user.id && !mod.hasModPerms(interaction.member, g)) { await reply("❌ Seul l'auteur du ticket ou le staff peut le fermer."); return; }
      await reply('🔒 Fermeture du ticket...');
      await closeTicket(guild, interaction.channel, g, interaction.user);
      return;
    }
  }

  if (cmd === 'permscmnds') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'list') {
      const lines = Object.entries(g.cmdPerms || {}).filter(([, r]) => r.length).map(([c, r]) => `/${c} : ${r.map((id) => `<@&${id}>`).join(' ')}`);
      await reply(lines.length ? `🔐 Autorisations par commande :\n${lines.join('\n')}` : 'Aucune autorisation par commande configurée.');
      return;
    }
    const commande = interaction.options.getString('commande').toLowerCase().replace(/^\//, '');
    const role = interaction.options.getRole('role');
    if (!g.cmdPerms) g.cmdPerms = {};
    if (!g.cmdPerms[commande]) g.cmdPerms[commande] = [];
    if (sub === 'allow') {
      if (!g.cmdPerms[commande].includes(role.id)) g.cmdPerms[commande].push(role.id);
      await db.save(guild.id); await reply(`✅ <@&${role.id}> peut maintenant utiliser \`/${commande}\`.`); return;
    }
    if (sub === 'deny') {
      g.cmdPerms[commande] = g.cmdPerms[commande].filter((r) => r !== role.id);
      await db.save(guild.id); await reply(`✅ <@&${role.id}> n'a plus cette autorisation sur \`/${commande}\`.`); return;
    }
  }

  if (cmd === 'findsalon') {
    const raw = interaction.options.getString('mot');
    const query = raw.toLowerCase();
    const matches = guild.channels.cache
      .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
      .filter((c) => c.permissionsFor(interaction.member)?.has(PermissionFlagsBits.ViewChannel))
      .filter((c) => c.name.toLowerCase().includes(query) || (c.topic || '').toLowerCase().includes(query))
      .sort((a, b) => a.rawPosition - b.rawPosition);
    if (!matches.size) { await reply(`🔍 Aucun salon trouvé pour "${raw}".`); return; }
    const lines = [...matches.values()].slice(0, 25).map((c) => `${c} — \`#${c.name}\`${c.topic ? ` : ${c.topic.slice(0, 80)}` : ''}`);
    await reply(`🔍 ${matches.size} salon(s) trouvé(s) pour "${raw}" :\n${lines.join('\n')}`);
    return;
  }

  if (cmd === 'findsource') {
    const channels = [interaction.options.getChannel('salon'), interaction.options.getChannel('salon2'), interaction.options.getChannel('salon3')].filter(Boolean);
    const rawMot = interaction.options.getString('mot');
    const mot = rawMot ? rawMot.toLowerCase() : null;
    const membre = interaction.options.getUser('membre');
    const limite = interaction.options.getInteger('limite') || 100;
    const URL_RE = /https?:\/\/\S+/i;

    let found = [];
    for (const channel of channels) {
      const perms = channel.permissionsFor(botMember);
      if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms?.has(PermissionFlagsBits.ReadMessageHistory)) continue;
      let fetched = 0, lastId;
      // Pagine par lots de 100 (max Discord) jusqu'à la limite demandée.
      while (fetched < limite) {
        const batch = await channel.messages.fetch({ limit: Math.min(100, limite - fetched), ...(lastId ? { before: lastId } : {}) }).catch(() => null);
        if (!batch || !batch.size) break;
        fetched += batch.size;
        lastId = batch.last().id;
        for (const m of batch.values()) {
          const isSource = m.attachments.size > 0 || URL_RE.test(m.content) || m.embeds.length > 0;
          if (!isSource) continue;
          if (membre && m.author.id !== membre.id) continue;
          if (mot && !m.content.toLowerCase().includes(mot)) continue;
          found.push(m);
        }
        if (batch.size < 100) break;
      }
    }

    if (!found.length) { await reply(`🔍 Aucune source trouvée dans ${channels.join(' ')}${mot ? ` pour "${rawMot}"` : ''}${membre ? ` de ${membre}` : ''}.`); return; }

    found.sort((a, b) => b.createdTimestamp - a.createdTimestamp);
    const top = found.slice(0, 15);
    const lines = top.map((m) => {
      const snippet = m.content ? (m.content.length > 100 ? `${m.content.slice(0, 100)}…` : m.content) : (m.attachments.size ? `📎 ${m.attachments.size} pièce(s) jointe(s)` : '🔗 lien');
      return `[🔗](${m.url}) **${m.author.tag}** dans ${m.channel} — <t:${Math.floor(m.createdTimestamp / 1000)}:R>\n> ${snippet}`;
    });
    const embed = new EmbedBuilder().setColor(mod.COLORS.source).setTitle(`🔍 Sources trouvées (${found.length}${found.length > top.length ? `, 15 plus récentes affichées` : ''})`)
      .setDescription(lines.join('\n\n').slice(0, 4000))
      .setFooter({ text: `Fouillé : ${channels.map((c) => `#${c.name}`).join(', ')}${mot ? ` · mot: "${rawMot}"` : ''}${membre ? ` · membre: ${membre.tag}` : ''}` });
    await interaction.editReply({ embeds: [embed] });
    return;
  }


  if (cmd === 'help') {
    const HELP_TEXT = [
      '**🛡️ Modération**',
      '`/kick` `/ban` `/unban` `/timeout` `/untimeout` — sanctionner un membre (expulsion, bannissement, mise en sourdine).',
      '`/warn` `/warnings` `/unwarn` — avertir un membre, voir ou retirer ses avertissements.',
      '`/clear` — supprimer des messages récents. `/slowmode` — régler le mode lent d\'un salon.',
      '`/lock` `/unlock` `/lockdown` `/unlockdown` — verrouiller un salon (ou tous) en cas de besoin.',
      '',
      '**📁 Historique**',
      '`/case` — voir le détail d\'un cas précis. `/modlogs` — voir tout l\'historique d\'un membre.',
      '',
      '**⚙️ Configuration**',
      '`/setmodlog` — définir le salon des logs. `/staffrole` — gérer qui peut modérer.',
      '`/permscmnds` — autoriser un rôle sur une commande précise. `/warnactions` — sanctions automatiques selon le nombre d\'avertissements.',
      '`/automod` — anti-lien, anti-spam, anti-mention, anti-raid, mots interdits personnalisés, et `/automod grosmots` (filtre intégré multilingue de gros mots, supprime automatiquement le message).',
      '',
      '**🎫 Tickets**',
      '`/ticket setup` — configurer la catégorie et le rôle support. `/ticket panel` — poster le bouton "Ouvrir un ticket".',
      'Une fois DANS un ticket : `/ticket close` (le ferme), `/ticket add` / `/ticket remove` (gérer qui y a accès).',
      '',
      '**🔍 Recherche**',
      '`/findsalon` — chercher un salon par mot-clé. `/findsource` — retrouver les liens/pièces jointes postés dans un ou plusieurs salons.',
      '',
      '**🤖 IA**',
      '`/ai` (configuration) · `/ask` (poser une question) · `/language` (langue principale par défaut du serveur).',
      'Mentionne le bot ou écris dans un salon IA pour discuter, dans n\'importe quelle langue : il retient la langue de chaque personne pour lui reparler pareil ensuite. Demande-lui "montre les logs" ou "logs du rôle X" (staff uniquement).',
    ].join('\n');

    const forcedLang = interaction.options.getString('langue');
    const savedUser = db.peekUser(interaction.user.id);
    const targetLang = forcedLang || savedUser?.language || null;
    let finalText = HELP_TEXT;
    if (targetLang && targetLang.toLowerCase() !== 'fr' && targetLang.toLowerCase() !== 'français' && process.env.GEMINI_API_KEY) {
      const t = await ai.translate(HELP_TEXT, targetLang);
      if (!t.error) finalText = t.text;
    }

    const embed = new EmbedBuilder().setColor(mod.COLORS.info).setTitle('📘 Commandes du bot').setDescription(finalText.slice(0, 4000));
    await interaction.editReply({ embeds: [embed] });
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

  if (interaction.commandName === 'ask') {
    await interaction.deferReply();
    const question = interaction.options.getString('question');
    const logsReply = await handleLogsIntent({ guild, member: interaction.member, g, text: question });
    if (logsReply) { await interaction.editReply({ content: logsReply, allowedMentions: { parse: [] } }); return; }
    const mentionedIds = [...new Set([...question.matchAll(/<@!?(\d+)>/g)].map((m) => m[1]))];
    const mentionedMembers = (await Promise.all(mentionedIds.map((id) => guild.members.cache.get(id) || guild.members.fetch(id).catch(() => null)))).filter(Boolean);
    const namedMembers = await resolveMembersByName(guild, question, [interaction.user.id, ...mentionedMembers.map((m) => m.id)]);
    const otherMembers = [...mentionedMembers, ...namedMembers];
    const savedUser = db.peekUser(interaction.user.id);
    const res = await ai.askClaude({ channelId: interaction.channelId, userId: interaction.user.id, userName: interaction.user.username, userText: question, persona: g.aiPersona, serverContext: buildServerContext(guild, interaction.member, otherMembers), savedLang: savedUser?.language || null, defaultLang: g.aiLanguage || null });
    if (res.langCode) { const u = db.getUser(interaction.user.id); if (u.language !== res.langCode) { u.language = res.langCode; await db.saveUser(interaction.user.id); } }
    await interaction.editReply(res.error ? `❌ ${res.error}` : res.text);
    return;
  }

  const nonStaffAllowed = new Set(['warnings', 'help', 'findsalon', 'ticket']); // /warnings et /ticket gèrent eux-mêmes leurs cas particuliers
  const roleAllowedForCmd = (g.cmdPerms?.[interaction.commandName] || []).some((r) => interaction.member.roles.cache.has(r));
  if (!nonStaffAllowed.has(interaction.commandName) && !roleAllowedForCmd && !mod.hasModPerms(interaction.member, g)) {
    await interaction.reply({ content: "❌ Tu n'as pas la permission d'utiliser cette commande (Administrateur, Gérer le serveur, ou un rôle autorisé via `/staffrole`).", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: ['warnings', 'modlogs', 'case', 'staffrole', 'warnactions', 'automod', 'ai', 'help', 'setmodlog', 'permscmnds', 'language', 'ticket'].includes(interaction.commandName) });
  await handleModCommand(interaction, guild, g);
}

// ----------------------------------------------------------------
// SYSTÈME DE TICKETS — interactions par bouton (panneau, prise en charge,
// fermeture avec confirmation).
// ----------------------------------------------------------------
async function routeButton(interaction) {
  if (!interaction.guildId || !interaction.customId.startsWith('ticket_')) return;
  const guild = interaction.guild;
  const g = db.get(guild.id);
  const t = g.tickets;

  if (interaction.customId === 'ticket_open') {
    if (!t.enabled || !t.categoryId) { await interaction.reply({ content: "❌ Le système de tickets n'est pas configuré.", ephemeral: true }); return; }
    const already = Object.entries(t.open).find(([, v]) => v.userId === interaction.user.id);
    if (already) { await interaction.reply({ content: `❌ Tu as déjà un ticket ouvert : <#${already[0]}>.`, ephemeral: true }); return; }

    await interaction.deferReply({ ephemeral: true });
    const number = t.counter++;
    const safeName = interaction.user.username.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20) || 'membre';
    let channel;
    try {
      channel = await guild.channels.create({
        name: `ticket-${number}-${safeName}`,
        type: ChannelType.GuildText,
        parent: t.categoryId,
        permissionOverwrites: [
          { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
          ...(t.supportRoleId ? [{ id: t.supportRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }] : []),
          { id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] },
        ],
      });
    } catch (e) { await interaction.editReply(`❌ Impossible de créer le salon de ticket (${e.message}).`); return; }

    t.open[channel.id] = { userId: interaction.user.id, claimedBy: null, createdAt: Date.now(), number };
    await db.save(guild.id);

    const embed = new EmbedBuilder().setColor(mod.COLORS.ticket).setTitle(`🎫 Ticket #${number}`)
      .setDescription(t.welcomeMessage || `Bienvenue ${interaction.user} ! Décris ta demande, un membre du staff va te répondre rapidement.`)
      .setFooter({ text: 'Système de tickets' }).setTimestamp();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket_claim').setLabel('Prendre en charge').setEmoji('🙋').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('ticket_close_ask').setLabel('Fermer').setEmoji('🔒').setStyle(ButtonStyle.Danger),
    );
    await channel.send({ content: `${interaction.user}${t.supportRoleId ? ` <@&${t.supportRoleId}>` : ''}`, embeds: [embed], components: [row] });
    await interaction.editReply(`✅ Ton ticket a été créé : ${channel}`);
    return;
  }

  const entry = t.open[interaction.channelId];
  if (!entry) { await interaction.reply({ content: "❌ Ce ticket n'existe plus.", ephemeral: true }); return; }

  if (interaction.customId === 'ticket_claim') {
    if (!mod.hasModPerms(interaction.member, g)) { await interaction.reply({ content: '❌ Réservé au staff.', ephemeral: true }); return; }
    entry.claimedBy = interaction.user.id;
    await db.save(guild.id);
    const oldEmbed = interaction.message.embeds[0];
    const embed = oldEmbed ? EmbedBuilder.from(oldEmbed).addFields({ name: 'Pris en charge par', value: `${interaction.user}` }) : new EmbedBuilder().setColor(mod.COLORS.ticket);
    const oldRow = interaction.message.components[0];
    const row = new ActionRowBuilder().addComponents(
      ButtonBuilder.from(oldRow.components[0]).setDisabled(true).setLabel('Pris en charge'),
      ButtonBuilder.from(oldRow.components[1]),
    );
    await interaction.update({ embeds: [embed], components: [row] });
    return;
  }

  if (interaction.customId === 'ticket_close_ask') {
    if (entry.userId !== interaction.user.id && !mod.hasModPerms(interaction.member, g)) { await interaction.reply({ content: "❌ Seul l'auteur du ticket ou le staff peut le fermer.", ephemeral: true }); return; }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket_close_confirm').setLabel('Confirmer la fermeture').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('ticket_close_cancel').setLabel('Annuler').setStyle(ButtonStyle.Secondary),
    );
    await interaction.reply({ content: '⚠️ Confirmer la fermeture de ce ticket ?', components: [row], ephemeral: true });
    return;
  }

  if (interaction.customId === 'ticket_close_cancel') { await interaction.update({ content: 'Fermeture annulée.', components: [] }); return; }

  if (interaction.customId === 'ticket_close_confirm') {
    await interaction.update({ content: '🔒 Fermeture en cours...', components: [] });
    await closeTicket(guild, interaction.channel, g, interaction.user);
    return;
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    await dbReadyPromise;
    if (interaction.isButton()) { await routeButton(interaction); return; }
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

    const text = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
    if (!text) return;

    const logsReply = await handleLogsIntent({ guild: message.guild, member: message.member, g, text });
    if (logsReply) { await message.reply({ content: logsReply, allowedMentions: { parse: [] } }); return; }

    await message.channel.sendTyping().catch(() => {});
    const mentionedMembers = [...message.mentions.members.values()].filter((m) => m.id !== client.user.id);
    const namedMembers = await resolveMembersByName(message.guild, text, [message.author.id, client.user.id, ...mentionedMembers.map((m) => m.id)]);
    const otherMembers = [...mentionedMembers, ...namedMembers];
    const savedUser = db.peekUser(message.author.id);
    const res = await ai.askClaude({ channelId: message.channelId, userId: message.author.id, userName: message.author.username, userText: text, persona: g.aiPersona, serverContext: buildServerContext(message.guild, message.member, otherMembers), savedLang: savedUser?.language || null, defaultLang: g.aiLanguage || null });
    if (res.langCode) { const u = db.getUser(message.author.id); if (u.language !== res.langCode) { u.language = res.langCode; await db.saveUser(message.author.id); } }
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
if (!process.env.DISCORD_TOKEN) console.error("❌ DISCORD_TOKEN manquant : ajoute-le dans les variables d'environnement.");
client.login(process.env.DISCORD_TOKEN).catch((e) => console.error('❌ Connexion Discord impossible :', e.message));

if (process.env.PUBLIC_URL) {
  const https = require('https');
  setInterval(() => {
    https.get(`${process.env.PUBLIC_URL.replace(/\/$/, '')}/health`, (res) => res.resume()).on('error', () => {});
  }, 10 * 60 * 1000);
}
