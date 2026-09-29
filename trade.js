// ================================================================
// trade.js — Panel d'échange "Steal a Brainrot"
//  • /brainrot post : poste ta photo + un bouton "🔄 Trade"
//  • Un membre intéressé clique "Trade" → un formulaire lui demande ce
//    qu'il propose en échange → le bot t'envoie ça en DM avec deux
//    boutons "✅ Accepter" / "❌ Refuser"
//  • Toi (le vendeur) tu acceptes ou refuses depuis ton DM, l'autre
//    membre reçoit la réponse en DM automatiquement.
// ================================================================
const {
  SlashCommandBuilder, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const db = require('./db');
const perms = require('./perms');

const RED = 0xFF0000;
const NO_PERM = "❌ Tu n'as pas la permission d'utiliser cette commande.";

function store(g) {
  if (!g.trades || typeof g.trades !== 'object') g.trades = {};
  const t = g.trades;
  if (!t.listings || typeof t.listings !== 'object') t.listings = {};
  if (!t.seq) t.seq = 0;
  if (t.channelId === undefined) t.channelId = null; // null = pas de restriction de salon
  return t;
}
const emb = () => new EmbedBuilder().setColor(RED);
const trunc = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);

function listingEmbed(listing, guild) {
  const e = emb().setTitle(`🧠 ${listing.itemName}`).setImage(listing.imageUrl)
    .setFooter({ text: `Posté par ${listing.ownerTag}` }).setTimestamp(listing.createdAt);
  if (listing.description) e.setDescription(listing.description);
  if (listing.wants) e.addFields({ name: '🔁 Recherche en échange', value: listing.wants });
  if (listing.status === 'cancelled') e.addFields({ name: ' ', value: '🗑️ **Retiré par son propriétaire.**' });
  return e;
}
function listingRow(listing) {
  if (listing.status === 'cancelled') return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`trade:offer:${listing.id}`).setLabel('Trade').setEmoji('🔄').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`trade:cancel:${listing.id}`).setLabel('Retirer').setEmoji('🗑️').setStyle(ButtonStyle.Secondary),
  )];
}

// ----------------------------------------------------------------
// COMMANDES
// ----------------------------------------------------------------
const listingOpt = (o) => o.setName('annonce').setDescription('Ton annonce').setRequired(true).setAutocomplete(true);
const commands = [
  new SlashCommandBuilder().setName('brainrot').setDescription('Panel d\'échange de brainrots')
    .addSubcommand((s) => s.setName('post').setDescription('Poster un brainrot à échanger')
      .addAttachmentOption((o) => o.setName('photo').setDescription('Photo de ton brainrot').setRequired(true))
      .addStringOption((o) => o.setName('nom').setDescription('Nom du brainrot').setRequired(true).setMaxLength(80))
      .addStringOption((o) => o.setName('veux').setDescription('Ce que tu recherches en échange (optionnel)').setMaxLength(200))
      .addStringOption((o) => o.setName('description').setDescription('Détails en plus (optionnel)').setMaxLength(500)))
    .addSubcommand((s) => s.setName('mine').setDescription('Voir tes annonces en cours'))
    .addSubcommand((s) => s.setName('remove').setDescription('Retirer une de tes annonces').addStringOption(listingOpt)),

  new SlashCommandBuilder().setName('tradeconfig').setDescription('(Staff) Configurer le salon d\'échange')
    .addSubcommand((s) => s.setName('salon').setDescription('Restreindre /brainrot post à un salon (vide = n\'importe où)')
      .addChannelOption((o) => o.setName('salon').setDescription('Salon dédié aux échanges').addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((s) => s.setName('voir').setDescription('Voir la configuration actuelle')),
].map((c) => c.setDMPermission(false).toJSON());

const COMMAND_NAMES = new Set(['brainrot', 'tradeconfig']);
const isTradeCommand = (name) => COMMAND_NAMES.has(name);

async function autocomplete(interaction) {
  if (!interaction.guildId) return;
  const t = store(db.get(interaction.guildId));
  const q = interaction.options.getFocused().toLowerCase();
  const mine = Object.values(t.listings).filter((l) => l.ownerId === interaction.user.id && l.status === 'open' && l.itemName.toLowerCase().includes(q));
  await interaction.respond(mine.slice(0, 25).map((l) => ({ name: `${l.itemName} (#${l.id})`.slice(0, 100), value: l.id }))).catch(() => {});
}

async function handleCommand(interaction) {
  const guild = interaction.guild;
  const g = db.get(guild.id);
  const t = store(g);
  const name = interaction.commandName;
  const sub = interaction.options.getSubcommand();

  if (name === 'tradeconfig') {
    if (!perms.canUseCommand(interaction.member, g, 'tradeconfig')) { await interaction.reply({ content: NO_PERM, ephemeral: true }); return; }
    await interaction.deferReply({ ephemeral: true });
    const reply = (c) => interaction.editReply({ content: c, allowedMentions: { parse: [] } });
    if (sub === 'salon') {
      const ch = interaction.options.getChannel('salon');
      t.channelId = ch ? ch.id : null;
      await db.save(guild.id);
      await reply(ch ? `✅ \`/brainrot post\` n'est utilisable que dans ${ch}.` : '✅ Restriction retirée : \`/brainrot post\` marche dans n\'importe quel salon.');
      return;
    }
    await reply(`⚙️ Salon d'échange : ${t.channelId ? `<#${t.channelId}>` : 'aucune restriction'}\n📦 Annonces ouvertes : ${Object.values(t.listings).filter((l) => l.status === 'open').length}`);
    return;
  }

  // ------------------------- /brainrot -------------------------
  if (sub === 'post') {
    if (t.channelId && interaction.channelId !== t.channelId) { await interaction.reply({ content: `❌ Les annonces ne peuvent être postées que dans <#${t.channelId}>.`, ephemeral: true }); return; }
    const photo = interaction.options.getAttachment('photo');
    if (!photo.contentType || !photo.contentType.startsWith('image/')) { await interaction.reply({ content: '❌ Le fichier joint doit être une image.', ephemeral: true }); return; }
    await interaction.deferReply();

    t.seq += 1;
    const listing = {
      id: String(t.seq), ownerId: interaction.user.id, ownerTag: interaction.user.tag,
      itemName: interaction.options.getString('nom'), wants: interaction.options.getString('veux') || '',
      description: interaction.options.getString('description') || '', imageUrl: photo.url,
      status: 'open', createdAt: Date.now(), channelId: interaction.channelId, messageId: null,
    };
    const msg = await interaction.editReply({ embeds: [listingEmbed(listing, guild)], components: listingRow(listing) });
    listing.messageId = msg.id;
    t.listings[listing.id] = listing;
    await db.save(guild.id);
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const reply = (c, extra = {}) => interaction.editReply({ content: c, allowedMentions: { parse: [] }, ...extra });

  if (sub === 'mine') {
    const mine = Object.values(t.listings).filter((l) => l.ownerId === interaction.user.id).sort((a, b) => b.createdAt - a.createdAt);
    if (!mine.length) { await reply('📦 Tu n\'as aucune annonce.'); return; }
    const lines = mine.slice(0, 20).map((l) => `**#${l.id}** — ${l.itemName} — ${l.status === 'open' ? `[voir](https://discord.com/channels/${guild.id}/${l.channelId}/${l.messageId})` : '🗑️ retiré'}`);
    await reply('', { embeds: [emb().setTitle('📦 Tes annonces').setDescription(lines.join('\n'))] });
    return;
  }
  if (sub === 'remove') {
    const listing = t.listings[interaction.options.getString('annonce')];
    if (!listing || listing.ownerId !== interaction.user.id) { await reply('❌ Annonce introuvable (choisis-la dans la liste proposée).'); return; }
    if (listing.status !== 'open') { await reply('❌ Cette annonce est déjà retirée.'); return; }
    listing.status = 'cancelled';
    await db.save(guild.id);
    const ch = guild.channels.cache.get(listing.channelId);
    const msg = ch ? await ch.messages.fetch(listing.messageId).catch(() => null) : null;
    if (msg) await msg.edit({ embeds: [listingEmbed(listing, guild)], components: [] }).catch(() => {});
    await reply(`✅ Annonce **${listing.itemName}** retirée.`);
    return;
  }
}

// ----------------------------------------------------------------
// BOUTONS / MODAL  (customId qui commence par "trade:")
// ----------------------------------------------------------------
async function handleComponent(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  const g = db.get(guild.id);
  const t = store(g);
  const id = interaction.customId;
  const eph = (payload) => interaction.reply({ ephemeral: true, allowedMentions: { parse: [] }, ...(typeof payload === 'string' ? { content: payload } : payload) });

  // ---------- Bouton "Trade" sur l'annonce ----------
  if (interaction.isButton() && id.startsWith('trade:offer:')) {
    const listing = t.listings[id.split(':')[2]];
    if (!listing || listing.status !== 'open') { await eph('❌ Cette annonce n\'est plus disponible.'); return; }
    if (listing.ownerId === interaction.user.id) { await eph('❌ Tu ne peux pas échanger avec toi-même.'); return; }
    const modal = new ModalBuilder().setCustomId(`trade:offermodal:${listing.id}`).setTitle(trunc(`Trade — ${listing.itemName}`, 45));
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('offer').setLabel('Que proposes-tu en échange ?').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500).setPlaceholder('Ex: mon Tralalero Tralala + 200 coins'),
    ));
    await interaction.showModal(modal);
    return;
  }

  // ---------- Bouton "Retirer" sur l'annonce (propriétaire uniquement) ----------
  if (interaction.isButton() && id.startsWith('trade:cancel:')) {
    const listing = t.listings[id.split(':')[2]];
    if (!listing) { await eph('❌ Annonce introuvable.'); return; }
    if (listing.ownerId !== interaction.user.id) { await eph('❌ Seul le propriétaire de l\'annonce peut la retirer.'); return; }
    if (listing.status !== 'open') { await eph('❌ Déjà retirée.'); return; }
    listing.status = 'cancelled';
    await db.save(guild.id);
    await interaction.update({ embeds: [listingEmbed(listing, guild)], components: [] });
    return;
  }

  // ---------- Formulaire d'offre soumis → DM au propriétaire ----------
  if (interaction.isModalSubmit() && id.startsWith('trade:offermodal:')) {
    const listing = t.listings[id.split(':')[2]];
    if (!listing || listing.status !== 'open') { await eph('❌ Cette annonce n\'est plus disponible.'); return; }
    const offerText = interaction.fields.getTextInputValue('offer');
    await interaction.deferReply({ ephemeral: true });

    const owner = await guild.members.fetch(listing.ownerId).catch(() => null);
    if (!owner) { await interaction.editReply('❌ Le propriétaire de cette annonce n\'est plus sur le serveur.'); return; }

    const dmEmbed = emb().setTitle(`🔄 Nouvelle offre pour "${listing.itemName}"`)
      .setThumbnail(listing.imageUrl)
      .setDescription(`**${interaction.user.tag}** (<@${interaction.user.id}>) propose :\n> ${offerText}`)
      .setFooter({ text: `Annonce #${listing.id} · ${guild.name}` }).setTimestamp();
    const dmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`trade:accept:${listing.id}:${interaction.user.id}`).setLabel('Accepter').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`trade:decline:${listing.id}:${interaction.user.id}`).setLabel('Refuser').setEmoji('❌').setStyle(ButtonStyle.Danger),
    );
    try {
      await owner.send({ embeds: [dmEmbed], components: [dmRow] });
      await interaction.editReply('✅ Ton offre a été envoyée en message privé au propriétaire !');
    } catch {
      await interaction.editReply('❌ Impossible d\'envoyer un DM au propriétaire (ses messages privés sont fermés). Essaie de le contacter directement.');
    }
    return;
  }

  // ---------- Accepter / Refuser (dans le DM du propriétaire) ----------
  if (interaction.isButton() && (id.startsWith('trade:accept:') || id.startsWith('trade:decline:'))) {
    const [, action, listingId, offererId] = id.split(':');
    const listing = t.listings[listingId];
    if (!listing) { await eph('❌ Cette annonce n\'existe plus.'); return; }
    if (interaction.user.id !== listing.ownerId) { await eph('❌ Seul le propriétaire de l\'annonce peut répondre à cette offre.'); return; }

    await interaction.deferUpdate();
    const offerer = await interaction.client.users.fetch(offererId).catch(() => null);
    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('trade:done_accept').setLabel('Accepté').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(true),
      new ButtonBuilder().setCustomId('trade:done_decline').setLabel('Refusé').setEmoji('❌').setStyle(ButtonStyle.Danger).setDisabled(true),
    );
    if (action === 'accept') {
      await interaction.editReply({ components: [disabledRow], content: `✅ Tu as accepté l'offre de <@${offererId}>. Contacte-le pour finaliser l'échange !` });
      if (offerer) await offerer.send(`✅ **${interaction.user.tag}** a accepté ton offre pour "**${listing.itemName}**" ! Contacte-le pour finaliser l'échange.`).catch(() => {});
    } else {
      await interaction.editReply({ components: [disabledRow], content: `❌ Tu as refusé l'offre de <@${offererId}>.` });
      if (offerer) await offerer.send(`❌ **${interaction.user.tag}** a refusé ton offre pour "**${listing.itemName}**".`).catch(() => {});
    }
    return;
  }
}

module.exports = { commands, isTradeCommand, handleCommand, handleComponent, autocomplete };
