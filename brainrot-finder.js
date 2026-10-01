const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, StringSelectMenuBuilder,
} = require('discord.js');
const db = require('./db');
const perms = require('./perms');

const RED = 0xFF0000;
const TIERS = ['LOW', 'MID', 'HIGH'];
const TIER_EMOJI = { LOW: '🟢', MID: '🟡', HIGH: '🔴' };
const TIER_DESC = { LOW: 'Lent (beaucoup de ms/frame)', MID: 'Moyen', HIGH: 'Rapide (peu de ms/frame)' };
const PAGE_SIZE = 1;

function store(g) {
  if (!g.brainrotFinder) g.brainrotFinder = {};
  const b = g.brainrotFinder;
  if (!Array.isArray(b.catalogue)) b.catalogue = [];
  if (!b.seq) b.seq = 0;
  if (!b.premiumRoleId) b.premiumRoleId = null;
  return b;
}
const emb = () => new EmbedBuilder().setColor(RED);
const hasPremium = (member, premiumRoleId) => !premiumRoleId || member.roles.cache.has(premiumRoleId);

function brainrotEmbed(entry, idx, total, premiumRoleId, isBrowser = false) {
  const tier = entry.tier || 'MID';
  const e = emb()
    .setTitle(`${TIER_EMOJI[tier]} ${entry.name}`)
    .setFooter({ text: `${TIER_EMOJI[tier]} Tier ${tier} — ${TIER_DESC[tier]} · ${idx + 1}/${total}` });
  if (entry.description) e.setDescription(entry.description);
  if (entry.imageUrl) e.setImage(entry.imageUrl);
  e.addFields(
    { name: 'Tier', value: `${TIER_EMOJI[tier]} **${tier}**`, inline: true },
    { name: 'Serveur', value: entry.invite ? `[Rejoindre](${entry.invite})` : '—', inline: true },
    { name: 'Premium', value: premiumRoleId ? `<@&${premiumRoleId}>` : 'Pas de restriction', inline: true },
  );
  return e;
}

function brainrotRow(entry, idx, total, isPremium, premiumRoleId, tier) {
  const filterVal = tier ? `tier:${tier}` : 'all';
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`bf:prev:${idx}:${filterVal}`).setLabel('◀ Precedent').setStyle(ButtonStyle.Secondary).setDisabled(idx <= 0),
    new ButtonBuilder().setCustomId(`bf:next:${idx}:${filterVal}`).setLabel('Suivant ▶').setStyle(ButtonStyle.Secondary).setDisabled(idx >= total - 1),
  );
  const joinBtn = new ButtonBuilder().setLabel('🔗 Join').setStyle(ButtonStyle.Danger);
  if (!isPremium) {
    joinBtn.setCustomId(`bf:nopremium:${entry.id}`).setDisabled(false);
  } else {
    joinBtn.setStyle(ButtonStyle.Link).setURL(entry.invite || 'https://discord.com');
  }
  const row2 = new ActionRowBuilder().addComponents(joinBtn);
  return [row1, row2];
}

const commands = [
  new SlashCommandBuilder().setName('brainrotfinder').setDescription('(Staff) Gerer le catalogue de brainrots')
  .addSubcommand(s => s.setName('add').setDescription('Ajouter un brainrot au catalogue')
    .addStringOption(o => o.setName('nom').setDescription('Nom du brainrot').setRequired(true).setMaxLength(80))
    .addStringOption(o => o.setName('tier').setDescription('Tier du brainrot').setRequired(true)
      .addChoices({ name: '🟢 LOW (lent)', value: 'LOW' }, { name: '🟡 MID', value: 'MID' }, { name: '🔴 HIGH (rapide)', value: 'HIGH' }))
    .addStringOption(o => o.setName('invite').setDescription('Lien d\'invitation Discord du serveur').setRequired(true).setMaxLength(200))
    .addStringOption(o => o.setName('image').setDescription('URL de l\'image ou du GIF').setRequired(true).setMaxLength(500))
    .addStringOption(o => o.setName('description').setDescription('Description courte (optionnel)').setMaxLength(300)))
  .addSubcommand(s => s.setName('remove').setDescription('Supprimer un brainrot')
    .addStringOption(o => o.setName('id').setDescription('ID du brainrot').setRequired(true).setAutocomplete(true)))
  .addSubcommand(s => s.setName('edit').setDescription('Modifier un brainrot')
    .addStringOption(o => o.setName('id').setDescription('ID du brainrot').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('nom').setDescription('Nouveau nom').setMaxLength(80))
    .addStringOption(o => o.setName('tier').setDescription('Nouveau tier')
      .addChoices({ name: '🟢 LOW', value: 'LOW' }, { name: '🟡 MID', value: 'MID' }, { name: '🔴 HIGH', value: 'HIGH' }))
    .addStringOption(o => o.setName('invite').setDescription('Nouveau lien d\'invitation').setMaxLength(200))
    .addStringOption(o => o.setName('image').setDescription('Nouvelle URL image/GIF').setMaxLength(500))
    .addStringOption(o => o.setName('description').setDescription('Nouvelle description (- = effacer)').setMaxLength(300)))
  .addSubcommand(s => s.setName('list').setDescription('Voir tous les brainrots du catalogue'))
  .setDMPermission(false),

  new SlashCommandBuilder().setName('brainrotfind').setDescription('Parcourir le Brainrot Finder')
    .addStringOption(o => o.setName('tier').setDescription('Filtrer par tier').addChoices(
      { name: '🟢 LOW', value: 'LOW' }, { name: '🟡 MID', value: 'MID' }, { name: '🔴 HIGH', value: 'HIGH' }, { name: '⭐ Tous', value: 'ALL' }
    )).setDMPermission(false),

  new SlashCommandBuilder().setName('brainrotconfig').setDescription('(Staff) Configurer le Brainrot Finder')
    .addSubcommand(s => s.setName('premium').setDescription('Definir le role premium requis pour Join (vide = tout le monde)')
      .addRoleOption(o => o.setName('role').setDescription('Role premium')))
    .addSubcommand(s => s.setName('voir').setDescription('Voir la configuration actuelle'))
    .setDMPermission(false),
].map(c => c.toJSON());

const COMMAND_NAMES = new Set(['brainrotfinder', 'brainrotfind', 'brainrotconfig']);
const isBFCommand = name => COMMAND_NAMES.has(name);

async function autocomplete(interaction) {
  if (!interaction.guildId) return;
  const b = store(db.get(interaction.guildId));
  const q = interaction.options.getFocused().toLowerCase();
  await interaction.respond(
    b.catalogue.filter(e => e.name.toLowerCase().includes(q) || e.id.includes(q))
      .slice(0, 25).map(e => ({ name: `[${e.tier}] ${e.name} (#${e.id})`.slice(0, 100), value: e.id }))
  ).catch(() => {});
}

async function handleCommand(interaction) {
  const guild = interaction.guild;
  const g = db.get(guild.id);
  const b = store(g);
  const name = interaction.commandName;
  const sub = interaction.options.getSubcommand(false);
  const isStaff = perms.hasStaff(interaction.member, g);

  if (name === 'brainrotconfig') {
    if (!isStaff) { await interaction.reply({ content: '❌ Reserve au staff.', ephemeral: true }); return; }
    await interaction.deferReply({ ephemeral: true });
    if (sub === 'premium') {
      const role = interaction.options.getRole('role');
      b.premiumRoleId = role ? role.id : null;
      await db.save(guild.id);
      await interaction.editReply(role ? `✅ Role premium : <@&${role.id}>. Seuls ces membres pourront cliquer **Join**.` : '✅ Restriction retiree — tout le monde peut rejoindre.');
      return;
    }
    await interaction.editReply(`⚙️ Role premium : ${b.premiumRoleId ? `<@&${b.premiumRoleId}>` : 'Aucun (tout le monde peut Join)'}\n📦 Brainrots dans le catalogue : **${b.catalogue.length}**`);
    return;
  }

  if (name === 'brainrotfinder') {
    if (!isStaff) { await interaction.reply({ content: '❌ Reserve au staff.', ephemeral: true }); return; }
    await interaction.deferReply({ ephemeral: true });
    const reply = t => interaction.editReply({ content: t, allowedMentions: { parse: [] } });

    if (sub === 'add') {
      b.seq += 1;
      const entry = {
        id: String(b.seq),
        name: interaction.options.getString('nom'),
        tier: interaction.options.getString('tier'),
        invite: interaction.options.getString('invite'),
        imageUrl: interaction.options.getString('image'),
        description: interaction.options.getString('description') || '',
        addedAt: Date.now(),
      };
      b.catalogue.push(entry);
      await db.save(guild.id);
      await reply(`✅ **${entry.name}** [${entry.tier}] ajoute au catalogue (#${entry.id}).`);
      return;
    }

    const entry = b.catalogue.find(e => e.id === interaction.options.getString('id'));
    if (!entry) { await reply('❌ Brainrot introuvable.'); return; }

    if (sub === 'remove') {
      b.catalogue = b.catalogue.filter(e => e !== entry);
      await db.save(guild.id);
      await reply(`✅ **${entry.name}** supprime du catalogue.`);
      return;
    }
    if (sub === 'edit') {
      const o = interaction.options;
      if (o.getString('nom')) entry.name = o.getString('nom');
      if (o.getString('tier')) entry.tier = o.getString('tier');
      if (o.getString('invite')) entry.invite = o.getString('invite');
      if (o.getString('image')) entry.imageUrl = o.getString('image');
      if (o.getString('description') !== null) entry.description = o.getString('description') === '-' ? '' : o.getString('description');
      await db.save(guild.id);
      await reply(`✅ **${entry.name}** [${entry.tier}] modifie.`);
      return;
    }
    if (sub === 'list') {
      if (!b.catalogue.length) { await reply('📦 Catalogue vide — utilise `/brainrotfinder add`.'); return; }
      const lines = b.catalogue.map(e => `**#${e.id}** ${TIER_EMOJI[e.tier]} [${e.tier}] **${e.name}** — ${e.invite}`);
      const chunks = [];
      let cur = '';
      for (const l of lines) { if ((cur + '\n' + l).length > 4000) { chunks.push(cur); cur = l; } else cur = cur ? cur + '\n' + l : l; }
      if (cur) chunks.push(cur);
      await interaction.editReply({ embeds: [emb().setTitle(`📦 Catalogue — ${b.catalogue.length} brainrot(s)`).setDescription(chunks[0])] });
      for (let i = 1; i < chunks.length; i++) await interaction.followUp({ embeds: [emb().setDescription(chunks[i])], ephemeral: true });
      return;
    }
  }

  if (name === 'brainrotfind') {
    await interaction.deferReply();
    const tierFilter = interaction.options.getString('tier') || 'ALL';
    const filtered = tierFilter === 'ALL' ? [...b.catalogue] : b.catalogue.filter(e => e.tier === tierFilter);

    if (!filtered.length) {
      await interaction.editReply({ embeds: [emb().setTitle('🔍 Brainrot Finder').setDescription(b.catalogue.length ? `Aucun brainrot en tier **${tierFilter}** pour le moment.` : 'Le catalogue est vide. Reviens plus tard !')] });
      return;
    }

    const idx = 0;
    const entry = filtered[idx];
    const isPremium = hasPremium(interaction.member, b.premiumRoleId);
    await interaction.editReply({
      embeds: [brainrotEmbed(entry, idx, filtered.length, b.premiumRoleId)],
      components: brainrotRow(entry, idx, filtered.length, isPremium, b.premiumRoleId, tierFilter === 'ALL' ? null : tierFilter),
    });
  }
}

async function handleComponent(interaction) {
  if (!interaction.isButton()) return;
  const guild = interaction.guild;
  if (!guild) return;
  const g = db.get(guild.id);
  const b = store(g);
  const id = interaction.customId;
  const eph = t => interaction.reply({ content: t, ephemeral: true, allowedMentions: { parse: [] } });

  if (id.startsWith('bf:nopremium:')) {
    const roleMention = b.premiumRoleId ? `<@&${b.premiumRoleId}>` : 'le role premium';
    await eph(`🔒 Le bouton **Join** est reserve aux membres ${roleMention}.\nObtiens ce role pour acceder aux liens d\'invitation !`);
    return;
  }

  if (id.startsWith('bf:prev:') || id.startsWith('bf:next:')) {
    const parts = id.split(':');
    const dir = parts[1];
    let idx = parseInt(parts[2], 10);
    const filterVal = parts[3] || 'all';
    const tierFilter = filterVal.startsWith('tier:') ? filterVal.slice(5) : null;
    const filtered = tierFilter ? b.catalogue.filter(e => e.tier === tierFilter) : [...b.catalogue];

    idx = dir === 'next' ? idx + 1 : idx - 1;
    if (idx < 0) idx = 0;
    if (idx >= filtered.length) idx = filtered.length - 1;

    const entry = filtered[idx];
    if (!entry) { await eph('❌ Plus de brainrots dans cette direction.'); return; }
    const isPremium = hasPremium(interaction.member, b.premiumRoleId);
    await interaction.update({
      embeds: [brainrotEmbed(entry, idx, filtered.length, b.premiumRoleId)],
      components: brainrotRow(entry, idx, filtered.length, isPremium, b.premiumRoleId, tierFilter),
    });
    return;
  }
}

module.exports = { commands, isBFCommand, handleCommand, handleComponent, autocomplete };
