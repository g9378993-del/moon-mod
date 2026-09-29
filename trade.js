// ================================================================
// trade.js — Panel d'échange "Steal a Brainrot"
//  • /tradeconfig panel : poste un panel fixe avec un bouton "➕ Create
//    Trade" — comme les membres n'ont pas accès aux commandes, c'est le
//    seul moyen pour eux de poster une annonce.
//  • Clic sur "Create Trade" → un formulaire (nom / recherché / description)
//    → le bot demande la photo dans le salon → dès qu'elle arrive, l'annonce
//    est postée avec un bouton "🔄 Trade" et un bouton "🗑️ Retirer".
//  • Un membre ne peut avoir qu'UNE annonce active à la fois : il doit la
//    retirer avant de pouvoir en créer une autre.
//  • Un membre intéressé clique "Trade" → un formulaire lui demande ce
//    qu'il propose en échange → le bot t'envoie ça en DM avec deux
//    boutons "✅ Accepter" / "❌ Refuser".
// ================================================================
const {
  SlashCommandBuilder, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits, AttachmentBuilder,
} = require('discord.js');
const db = require('./db');
const perms = require('./perms');

const RED = 0xFF0000;
const NO_PERM = "❌ Tu n'as pas la permission d'utiliser cette commande.";
const PHOTO_WAIT_MS = 2 * 60 * 1000; // 2 minutes pour envoyer la photo après le formulaire

function store(g) {
  if (!g.trades || typeof g.trades !== 'object') g.trades = {};
  const t = g.trades;
  if (!t.listings || typeof t.listings !== 'object') t.listings = {};
  if (!t.seq) t.seq = 0;
  if (t.channelId === undefined) t.channelId = null; // null = pas de restriction de salon pour poster
  if (!t.panel) t.panel = { channelId: null, messageId: null };
  return t;
}
const emb = () => new EmbedBuilder().setColor(RED);
const trunc = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);
// Une seule annonce active par membre à la fois.
const findOpenListing = (t, userId) => Object.values(t.listings).find((l) => l.ownerId === userId && l.status === 'open');

function listingEmbed(listing) {
  const e = emb().setTitle(`🧠 ${listing.itemName}`).setImage(listing.imageUrl)
    .setFooter({ text: `Posté par ${listing.ownerTag}` }).setTimestamp(listing.createdAt);
  if (listing.description) e.setDescription(listing.description);
  if (listing.wants) e.addFields({ name: '🔁 Recherche en échange', value: listing.wants });
  if (listing.status === 'cancelled') e.addFields({ name: ' ', value: '🗑️ **Retiré par son propriétaire.**' });
  return e;
}
function listingRow(listing) {
  const createBtn = new ButtonBuilder().setCustomId('trade:panel:create').setLabel('Create Trade').setEmoji('➕').setStyle(ButtonStyle.Danger);
  if (listing.status === 'cancelled') return [new ActionRowBuilder().addComponents(createBtn)];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`trade:offer:${listing.id}`).setLabel('Trade').setEmoji('🔄').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`trade:cancel:${listing.id}`).setLabel('Retirer').setEmoji('🗑️').setStyle(ButtonStyle.Secondary),
    createBtn,
  )];
}
function panelPayload(guild, t) {
  const openCount = Object.values(t.listings).filter((l) => l.status === 'open').length;
  const embed = emb().setTitle('🔄 Brainrot Trading')
    .setDescription([
      "Tu as un brainrot à échanger ? Clique **Create Trade** ci-dessous.",
      "1️⃣ Remplis le formulaire (nom, ce que tu recherches, description)",
      "2️⃣ Envoie la photo de ton brainrot dans ce salon quand le bot te le demande",
      "3️⃣ Ton annonce est postée avec un bouton **Trade** — les autres membres pourront te faire une offre, que tu recevras en message privé.",
      "\n⚠️ Une seule annonce active à la fois : retire la tienne (bouton **Retirer**) avant d'en créer une nouvelle.",
    ].join('\n'))
    .setFooter({ text: `${openCount} annonce(s) active(s)` });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('trade:panel:create').setLabel('Create Trade').setEmoji('➕').setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row] };
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

  new SlashCommandBuilder().setName('tradeconfig').setDescription('(Staff) Configurer les échanges de brainrots')
    .addSubcommand((s) => s.setName('salon').setDescription('Restreindre les annonces à un salon (vide = n\'importe où)')
      .addChannelOption((o) => o.setName('salon').setDescription('Salon dédié aux échanges').addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((s) => s.setName('panel').setDescription('Poster le panel avec le bouton "Create Trade"')
      .addChannelOption((o) => o.setName('salon').setDescription('Salon où poster le panel (défaut : ici)').addChannelTypes(ChannelType.GuildText)))
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

// Termine la création d'une annonce (utilisé par /brainrot post ET le
// formulaire du panel) une fois qu'on a nom / photo / etc.
// fields.imageFile (optionnel) : un AttachmentBuilder à joindre au message
// (cas du panel, où la photo doit être ré-uploadée — voir plus bas).
async function publishListing(guild, t, targetChannel, owner, fields) {
  t.seq += 1;
  const listing = {
    id: String(t.seq), ownerId: owner.id, ownerTag: owner.tag,
    itemName: fields.itemName, wants: fields.wants || '', description: fields.description || '',
    imageUrl: fields.imageUrl, status: 'open', createdAt: Date.now(), channelId: targetChannel.id, messageId: null,
  };
  const payload = { embeds: [listingEmbed(listing)], components: listingRow(listing) };
  if (fields.imageFile) payload.files = [fields.imageFile];
  const msg = await targetChannel.send(payload);
  // Si on a joint un fichier (cas du panel), on remplace l'URL "attachment://"
  // par l'URL Discord réelle de la pièce jointe sur CE message (stable tant
  // que ce message n'est pas supprimé), pour les futurs affichages (DM, etc.).
  if (fields.imageFile) {
    const att = msg.attachments?.first?.();
    if (att) listing.imageUrl = att.url;
  }
  listing.messageId = msg.id;
  t.listings[listing.id] = listing;
  await db.save(guild.id);
  return { listing, msg };
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
      await reply(ch ? `✅ Les annonces (postées par le panel ou \`/brainrot post\`) apparaîtront dans ${ch}.` : "✅ Restriction retirée : les annonces apparaissent dans le salon où l'action a lieu.");
      return;
    }
    if (sub === 'panel') {
      const channel = interaction.options.getChannel('salon') || interaction.channel;
      const perm = channel.permissionsFor(guild.members.me);
      if (!perm?.has(PermissionFlagsBits.EmbedLinks) || !perm?.has(PermissionFlagsBits.SendMessages)) { await reply(`❌ Il me manque **Envoyer des messages** ou **Intégrer des liens** dans ${channel}.`); return; }
      try {
        const msg = await channel.send(panelPayload(guild, t));
        if (t.panel.channelId && t.panel.messageId) {
          const oldCh = guild.channels.cache.get(t.panel.channelId);
          if (oldCh) oldCh.messages.delete(t.panel.messageId).catch(() => {});
        }
        t.panel.channelId = channel.id; t.panel.messageId = msg.id;
        await db.save(guild.id);
        await reply(`✅ Panel posté dans ${channel}.`);
      } catch (err) { await reply(`❌ Impossible de poster dans ${channel} (${err.message}).`); }
      return;
    }
    await reply(`⚙️ Salon des annonces : ${t.channelId ? `<#${t.channelId}>` : 'n\'importe où'}\n🖼️ Panel : ${t.panel.channelId ? `<#${t.panel.channelId}>` : 'pas encore posté'}\n📦 Annonces ouvertes : ${Object.values(t.listings).filter((l) => l.status === 'open').length}`);
    return;
  }

  // ------------------------- /brainrot -------------------------
  if (sub === 'post') {
    if (t.channelId && interaction.channelId !== t.channelId) { await interaction.reply({ content: `❌ Les annonces ne peuvent être postées que dans <#${t.channelId}>.`, ephemeral: true }); return; }
    const existing = findOpenListing(t, interaction.user.id);
    if (existing) { await interaction.reply({ content: `❌ Tu as déjà une annonce active : **${existing.itemName}**. Retire-la d'abord (bouton **Retirer** sur son message, ou \`/brainrot remove\`).`, ephemeral: true }); return; }
    const photo = interaction.options.getAttachment('photo');
    if (!photo.contentType || !photo.contentType.startsWith('image/')) { await interaction.reply({ content: '❌ Le fichier joint doit être une image.', ephemeral: true }); return; }
    await interaction.deferReply();
    const targetChannel = t.channelId ? (guild.channels.cache.get(t.channelId) || interaction.channel) : interaction.channel;
    const { listing } = await publishListing(guild, t, targetChannel, interaction.user, {
      itemName: interaction.options.getString('nom'), wants: interaction.options.getString('veux'), description: interaction.options.getString('description'), imageUrl: photo.url,
    });
    await interaction.editReply(targetChannel.id === interaction.channelId ? { content: null, embeds: [listingEmbed(listing)], components: listingRow(listing) } : `✅ Annonce postée dans <#${targetChannel.id}>.`);
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
    if (msg) await msg.edit({ embeds: [listingEmbed(listing)], components: listingRow(listing) }).catch(() => {});
    await reply(`✅ Annonce **${listing.itemName}** retirée.`);
    return;
  }
}

// ----------------------------------------------------------------
// Attend la photo envoyée par l'utilisateur dans le salon, après le
// formulaire du panel, puis publie l'annonce.
// ----------------------------------------------------------------
function collectPhotoAndPublish(interaction, guild, t, fields) {
  const channel = interaction.channel;
  const collector = channel.createMessageCollector({
    filter: (m) => m.author.id === interaction.user.id && m.attachments.size > 0 && [...m.attachments.values()][0].contentType?.startsWith('image/'),
    time: PHOTO_WAIT_MS, max: 1,
  });
  collector.on('collect', async (m) => {
    try {
      // On revérifie la limite au cas où une autre annonce aurait été créée entre-temps.
      const already = findOpenListing(t, interaction.user.id);
      if (already) { await interaction.editReply(`❌ Tu as déjà une annonce active : **${already.itemName}**. Retire-la d'abord.`); m.delete().catch(() => {}); return; }

      // L'URL Discord d'une pièce jointe ne fonctionne plus une fois son
      // message supprimé (or on supprime le message-photo juste après, pour
      // garder le salon propre) : on télécharge donc l'image AVANT de le
      // supprimer, pour la ré-uploader directement sur le message de l'annonce.
      const originalAttachment = m.attachments.first();
      const filename = (originalAttachment.name || 'brainrot.png').replace(/[^\w.\-]/g, '_');
      let imageFile;
      try {
        const res = await fetch(originalAttachment.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        imageFile = new AttachmentBuilder(buf, { name: filename });
      } catch (dlErr) {
        console.error('Erreur téléchargement photo /trade :', dlErr);
        await interaction.editReply('❌ Je n\'ai pas réussi à récupérer ta photo, réessaie (reclique sur **Create Trade**).');
        return;
      }

      const targetChannel = t.channelId ? (guild.channels.cache.get(t.channelId) || channel) : channel;
      const { listing } = await publishListing(guild, t, targetChannel, interaction.user, { ...fields, imageUrl: `attachment://${filename}`, imageFile });
      m.delete().catch(() => {}); // on nettoie le salon, la photo vit maintenant sur le message de l'annonce
      await interaction.editReply(`✅ Annonce **${listing.itemName}** publiée dans <#${targetChannel.id}> !`);
    } catch (err) {
      console.error('Erreur publication annonce (panel) :', err);
      await interaction.editReply(`❌ Erreur pendant la publication : ${err.message || err}.`).catch(() => {});
    }
  });
  collector.on('end', (collected) => {
    if (collected.size === 0) interaction.editReply('⏰ Temps écoulé (2 min), aucune photo reçue. Reclique sur **Create Trade** pour recommencer.').catch(() => {});
  });
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

  // ---------- Bouton "Create Trade" du panel ----------
  if (interaction.isButton() && id === 'trade:panel:create') {
    const existing = findOpenListing(t, interaction.user.id);
    if (existing) { await eph(`❌ Tu as déjà une annonce active : **${existing.itemName}**. Clique **Retirer** sur son message (ou \`/brainrot remove\`) avant d'en créer une nouvelle.`); return; }
    const modal = new ModalBuilder().setCustomId('trade:panelmodal').setTitle('Créer une annonce');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nom').setLabel('Nom du brainrot').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('veux').setLabel('Ce que tu recherches (optionnel)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Description (optionnel)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500)),
    );
    await interaction.showModal(modal);
    return;
  }

  // ---------- Formulaire du panel soumis → on demande la photo ----------
  if (interaction.isModalSubmit() && id === 'trade:panelmodal') {
    const existing = findOpenListing(t, interaction.user.id);
    if (existing) { await eph(`❌ Tu as déjà une annonce active : **${existing.itemName}**. Retire-la d'abord.`); return; }
    await interaction.deferReply({ ephemeral: true });
    await interaction.editReply(`📸 Envoie maintenant la **photo** de ton brainrot ici, dans ce salon (tu as ${Math.round(PHOTO_WAIT_MS / 60000)} minutes).`);
    collectPhotoAndPublish(interaction, guild, t, {
      itemName: interaction.fields.getTextInputValue('nom'),
      wants: interaction.fields.getTextInputValue('veux'),
      description: interaction.fields.getTextInputValue('description'),
    });
    return;
  }

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
    await interaction.update({ embeds: [listingEmbed(listing)], components: listingRow(listing) });
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
