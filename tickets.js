// ================================================================
// tickets.js — Système de tickets
//
// Flow admin :
//   /ticket setup  → menu de configuration live (aperçu embed + boutons d'action)
//   Dans le menu :  Modifier titre/desc/couleur | Ajouter bouton | Supprimer bouton
//                   Configurer staff/catégorie/logs | Aperçu | Poster l'embed
//
// Données dans g.tickets :
//   staffRoleId, logChannelId, categoryId
//   embedChannelId, embedMessageId
//   title, description, color
//   buttons[]  : { id, label, emoji, style, questions[] }
//   open{}     : { [channelId]: { userId, buttonId, answers, openedAt, ticketNum } }
//   counter    : numéro incrémental
// ================================================================
const {
  SlashCommandBuilder, PermissionFlagsBits, MessageFlags,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelType,
} = require('discord.js');
const db = require('./db');

const isTicketCommand = (name) => name === 'ticket';

// ----------------------------------------------------------------
// UTILITAIRES
// ----------------------------------------------------------------
function ensureTickets(g) {
  if (!g.tickets || typeof g.tickets !== 'object') g.tickets = {};
  if (!Array.isArray(g.tickets.buttons)) g.tickets.buttons = [];
  if (!g.tickets.open || typeof g.tickets.open !== 'object') g.tickets.open = {};
  if (!g.tickets.counter) g.tickets.counter = 0;
  if (!g.tickets.title) g.tickets.title = '🎫 Support';
  if (!g.tickets.description) g.tickets.description = 'Clique sur un bouton ci-dessous pour ouvrir un ticket.';
}

function hexToInt(hex) {
  if (!hex) return 0xFF0000;
  const n = parseInt(hex.replace('#', ''), 16);
  return isNaN(n) ? 0xFF0000 : n;
}

// Embed aperçu (affiché dans le menu de config)
function buildPreviewEmbed(g) {
  ensureTickets(g);
  const embed = new EmbedBuilder()
    .setTitle(g.tickets.title)
    .setDescription(g.tickets.description)
    .setColor(hexToInt(g.tickets.color))
    .setFooter({ text: 'Aperçu — ceci est à quoi ressemblera l\'embed public.' });

  const btns = g.tickets.buttons;
  if (btns.length) {
    embed.addFields({
      name: `Boutons configurés (${btns.length})`,
      value: btns.map((b) => `${b.emoji || '•'} **${b.label}**${b.questions?.length ? ` — ${b.questions.length} question(s)` : ''}`).join('\n'),
    });
  } else {
    embed.addFields({ name: 'Boutons', value: '*Aucun bouton — ajoutes-en via le menu ci-dessous.*' });
  }

  const cfg = [];
  if (g.tickets.logChannelId) cfg.push(`📋 Logs : <#${g.tickets.logChannelId}>`);
  if (cfg.length) embed.addFields({ name: 'Configuration', value: cfg.join('\n') });

  return embed;
}

// Lignes de boutons du panel public
function buildPanelRows(g) {
  ensureTickets(g);
  const btns = g.tickets.buttons.slice(0, 25);
  const rows = [];
  for (let i = 0; i < btns.length; i += 5) {
    const row = new ActionRowBuilder().addComponents(
      btns.slice(i, i + 5).map((b) => {
        const styleMap = { PRIMARY: ButtonStyle.Primary, SECONDARY: ButtonStyle.Secondary, SUCCESS: ButtonStyle.Success, DANGER: ButtonStyle.Danger };
        const btn = new ButtonBuilder()
          .setCustomId(`ticket_open_${b.id}`)
          .setLabel(b.label)
          .setStyle(styleMap[b.style] || ButtonStyle.Primary);
        if (b.emoji) try { btn.setEmoji(b.emoji); } catch {}
        return btn;
      })
    );
    rows.push(row);
  }
  return rows;
}

// Embed public (posté dans le salon)
function buildPanelEmbed(g) {
  ensureTickets(g);
  return new EmbedBuilder()
    .setTitle(g.tickets.title)
    .setDescription(g.tickets.description)
    .setColor(hexToInt(g.tickets.color))
    .setFooter({ text: 'Ouvre un ticket en cliquant sur un bouton.' });
}

// ----------------------------------------------------------------
// MENU DE CONFIGURATION (affiché après /ticket setup)
// ----------------------------------------------------------------
function buildSetupMenu(g) {
  ensureTickets(g);

  // Ligne 1 — modifier l'embed
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tsetup_edit_embed').setLabel('✏️ Modifier titre / description').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tsetup_edit_color').setLabel('🎨 Couleur').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tsetup_edit_config').setLabel('⚙️ Salon des logs').setStyle(ButtonStyle.Secondary),
  );

  // Ligne 2 — boutons
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tsetup_add_btn').setLabel('➕ Ajouter un bouton').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('tsetup_remove_btn').setLabel('➖ Supprimer un bouton').setStyle(ButtonStyle.Danger)
      .setDisabled(!g.tickets.buttons.length),
    new ButtonBuilder().setCustomId('tsetup_list_btns').setLabel('📋 Voir les boutons').setStyle(ButtonStyle.Secondary)
      .setDisabled(!g.tickets.buttons.length),
  );

  // Ligne 3 — poster (disponible dès qu'il y a au moins 1 bouton)
  const canPost = g.tickets.buttons.length > 0;
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tsetup_post').setLabel('📢 Poster l\'embed').setStyle(ButtonStyle.Primary)
      .setDisabled(!canPost),
    new ButtonBuilder().setCustomId('tsetup_close').setLabel('✅ Terminer').setStyle(ButtonStyle.Secondary),
  );

  return [row1, row2, row3];
}

// Envoie / met à jour le message de setup (ephemeral)
// mode: 'editReply' (après deferReply), 'reply' (première réponse), 'update' (bouton)
async function sendSetupMessage(interaction, g, mode = 'editReply') {
  const embed = buildPreviewEmbed(g);
  const rows = buildSetupMenu(g);
  const payload = { embeds: [embed], components: rows, flags: MessageFlags.Ephemeral };
  if (mode === 'editReply') await interaction.editReply(payload);
  else if (mode === 'update') await interaction.update(payload);
  else await interaction.reply(payload);
}

// ----------------------------------------------------------------
// COMMANDES SLASH
// ----------------------------------------------------------------
const commands = [
  new SlashCommandBuilder().setName('ticket')
    .setDescription('(Admin) Ouvrir le panneau de configuration des tickets'),
].map((c) => c.setDMPermission(false).toJSON());

// ----------------------------------------------------------------
// HANDLER COMMANDE /ticket
// ----------------------------------------------------------------
async function handleCommand(interaction, client) {
  const guild = interaction.guild;
  const g = db.get(guild.id);
  ensureTickets(g);

  const member = interaction.member;
  const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator) ||
                  member.permissions.has(PermissionFlagsBits.ManageGuild) ||
                  guild.ownerId === member.id;
  if (!isAdmin) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: '❌ Seuls les Administrateurs / Gérer le serveur peuvent configurer les tickets.' });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await sendSetupMessage(interaction, g);
}

// ----------------------------------------------------------------
// HANDLER BOUTONS DU MENU SETUP
// ----------------------------------------------------------------
async function handleSetupButton(interaction, client) {
  const guild = interaction.guild;
  const g = db.get(guild.id);
  ensureTickets(g);
  const id = interaction.customId;

  // ---- Modifier titre / description ----
  if (id === 'tsetup_edit_embed') {
    const modal = new ModalBuilder().setCustomId('tsetup_modal_embed').setTitle('Modifier l\'embed');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('title').setLabel('Titre').setStyle(TextInputStyle.Short)
          .setValue(g.tickets.title).setRequired(true).setMaxLength(100)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('desc').setLabel('Description').setStyle(TextInputStyle.Paragraph)
          .setValue(g.tickets.description).setRequired(true).setMaxLength(1000)
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  // ---- Modifier couleur ----
  if (id === 'tsetup_edit_color') {
    const modal = new ModalBuilder().setCustomId('tsetup_modal_color').setTitle('Couleur de l\'embed');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('color').setLabel('Couleur hex (ex: #FF5500)').setStyle(TextInputStyle.Short)
          .setValue(g.tickets.color || '#FF0000').setRequired(true).setMaxLength(7)
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  // ---- Configurer logs uniquement ----
  if (id === 'tsetup_edit_config') {
    const modal = new ModalBuilder().setCustomId('tsetup_modal_config').setTitle('Configuration');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('logs').setLabel('ID salon logs (optionnel)').setStyle(TextInputStyle.Short)
          .setValue(g.tickets.logChannelId || '').setRequired(false).setPlaceholder('Laisse vide si pas de logs')
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  // ---- Ajouter un bouton ----
  if (id === 'tsetup_add_btn') {
    if (g.tickets.buttons.length >= 25) {
      await interaction.deferUpdate();
      await interaction.followUp({ flags: MessageFlags.Ephemeral, content: '❌ Maximum 25 boutons atteint.' });
      return;
    }
    const modal = new ModalBuilder().setCustomId('tsetup_modal_addbtn').setTitle('Ajouter un bouton');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('btn_label').setLabel('Nom du bouton (ex: Support)').setStyle(TextInputStyle.Short)
          .setRequired(true).setMaxLength(80)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('btn_emoji').setLabel('Emoji (ex: 🎫 — optionnel)').setStyle(TextInputStyle.Short)
          .setRequired(false).setMaxLength(50)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('btn_style').setLabel('Style : PRIMARY / SECONDARY / SUCCESS / DANGER').setStyle(TextInputStyle.Short)
          .setValue('PRIMARY').setRequired(false).setMaxLength(10)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('btn_questions').setLabel('Questions séparées par ; (optionnel)').setStyle(TextInputStyle.Paragraph)
          .setRequired(false).setMaxLength(500).setPlaceholder('Ton pseudo;Ton problème;Depuis quand?')
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  // ---- Supprimer un bouton ----
  if (id === 'tsetup_remove_btn') {
    // Affiche la liste puis ouvre un modal
    const modal = new ModalBuilder().setCustomId('tsetup_modal_removebtn').setTitle('Supprimer un bouton');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('nom').setLabel('Nom exact du bouton à supprimer').setStyle(TextInputStyle.Short)
          .setRequired(true).setMaxLength(80).setPlaceholder(g.tickets.buttons[0]?.label || 'Nom du bouton')
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  // ---- Voir les boutons ----
  if (id === 'tsetup_list_btns') {
    const lines = g.tickets.buttons.map((b, i) => {
      const qs = b.questions?.length ? b.questions.map((q) => `\n    ❓ ${q}`).join('') : ' *(aucune question)*';
      return `**${i + 1}.** ${b.emoji || ''} ${b.label}${qs}`;
    });
    // deferUpdate pour pas toucher le menu principal, puis followUp éphémère
    await interaction.deferUpdate();
    await interaction.followUp({ flags: MessageFlags.Ephemeral, content: lines.join('\n\n') || 'Aucun bouton.' });
    return;
  }

  // ---- Poster l'embed ----
  if (id === 'tsetup_post') {
    await interaction.deferUpdate();
    // Poster dans le salon où la commande a été utilisée
    const targetChannel = interaction.channel;
    const rows = buildPanelRows(g);
    if (!rows.length) {
      await interaction.followUp({ flags: MessageFlags.Ephemeral, content: '❌ Aucun bouton configuré.' });
      return;
    }
    try {
      // Supprime l'ancien embed si existant (dans n'importe quel salon)
      if (g.tickets.embedChannelId && g.tickets.embedMessageId) {
        try {
          const oldCh = guild.channels.cache.get(g.tickets.embedChannelId);
          if (oldCh) await oldCh.messages.fetch(g.tickets.embedMessageId).then((m) => m.delete());
        } catch {}
      }
      const msg = await targetChannel.send({ embeds: [buildPanelEmbed(g)], components: rows });
      g.tickets.embedChannelId = targetChannel.id;
      g.tickets.embedMessageId = msg.id;
      await db.save(guild.id);
      await interaction.followUp({ flags: MessageFlags.Ephemeral, content: `✅ Embed posté dans <#${targetChannel.id}> !` });
    } catch (e) {
      await interaction.followUp({ flags: MessageFlags.Ephemeral, content: `❌ Erreur : ${e.message}` });
    }
    return;
  }

  // ---- Terminer ----
  if (id === 'tsetup_close') {
    await interaction.update({ content: '✅ Configuration terminée.', embeds: [], components: [] });
    return;
  }
}

// ----------------------------------------------------------------
// HANDLER MODALS DU MENU SETUP
// ----------------------------------------------------------------
async function handleSetupModal(interaction, client) {
  const guild = interaction.guild;
  const g = db.get(guild.id);
  ensureTickets(g);
  const id = interaction.customId;

  // Après un modal Discord, reply() crée un NOUVEAU message éphémère — ça ne met
  // pas à jour le menu setup existant et peut déclencher une erreur si Discord
  // considère l'interaction déjà répondue. Le pattern correct :
  //   1. deferReply({ flags: Ephemeral })  — accuse réception du modal
  //   2. editReply(...)                    — envoie le menu mis à jour dans ce même message
  // Ça remplace l'ancien menu setup par la version fraîche sans conflit.

  async function refreshSetup(errorMsg) {
    // Les interactions modales n'acceptent pas deferReply — elles acceptent
    // reply() directement. On répond avec le menu mis à jour en éphémère.
    const embed = buildPreviewEmbed(g);
    const rows = buildSetupMenu(g);
    if (errorMsg) {
      await interaction.reply({ flags: MessageFlags.Ephemeral, content: errorMsg, embeds: [], components: [] });
      return;
    }
    await interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [embed], components: rows });
  }

  // ---- Embed titre/desc ----
  if (id === 'tsetup_modal_embed') {
    g.tickets.title = interaction.fields.getTextInputValue('title');
    g.tickets.description = interaction.fields.getTextInputValue('desc');
    await db.save(guild.id);
    await refreshSetup();
    return;
  }

  // ---- Couleur ----
  if (id === 'tsetup_modal_color') {
    const c = interaction.fields.getTextInputValue('color').trim();
    if (!/^#?[0-9a-fA-F]{6}$/.test(c)) {
      await refreshSetup('❌ Couleur invalide. Format attendu : `#FF5500`');
      return;
    }
    g.tickets.color = c.startsWith('#') ? c : `#${c}`;
    await db.save(guild.id);
    await refreshSetup();
    return;
  }

  // ---- Config logs ----
  if (id === 'tsetup_modal_config') {
    const logs = interaction.fields.getTextInputValue('logs').trim();
    if (logs) {
      const logCh = guild.channels.cache.get(logs);
      if (!logCh) { await refreshSetup(`❌ Salon logs introuvable : \`${logs}\`.`); return; }
      g.tickets.logChannelId = logs;
    } else { delete g.tickets.logChannelId; }
    await db.save(guild.id);
    await refreshSetup();
    return;
  }

  // ---- Ajouter bouton ----
  if (id === 'tsetup_modal_addbtn') {
    const label = interaction.fields.getTextInputValue('btn_label').trim();
    const emoji = interaction.fields.getTextInputValue('btn_emoji').trim() || null;
    const styleRaw = interaction.fields.getTextInputValue('btn_style').trim().toUpperCase();
    const questionsRaw = interaction.fields.getTextInputValue('btn_questions').trim();

    const validStyles = ['PRIMARY', 'SECONDARY', 'SUCCESS', 'DANGER'];
    const style = validStyles.includes(styleRaw) ? styleRaw : 'PRIMARY';
    const questions = questionsRaw ? questionsRaw.split(';').map((q) => q.trim()).filter(Boolean).slice(0, 5) : [];
    const btnId = `btn_${Date.now().toString(36)}`;

    g.tickets.buttons.push({ id: btnId, label, emoji, style, questions });
    await db.save(guild.id);
    await refreshSetup();
    return;
  }

  // ---- Supprimer bouton ----
  if (id === 'tsetup_modal_removebtn') {
    const nom = interaction.fields.getTextInputValue('nom').toLowerCase().trim();
    const before = g.tickets.buttons.length;
    g.tickets.buttons = g.tickets.buttons.filter((b) => b.label.toLowerCase() !== nom);
    if (g.tickets.buttons.length === before) {
      await refreshSetup(`❌ Bouton \`${nom}\` introuvable.`);
      return;
    }
    await db.save(guild.id);
    await refreshSetup();
    return;
  }
}

// ----------------------------------------------------------------
// HANDLER BOUTON OUVERTURE TICKET (panel public)
// ----------------------------------------------------------------
async function handleOpenButton(interaction, client) {
  const guild = interaction.guild;
  const g = db.get(guild.id);
  ensureTickets(g);

  const btnId = interaction.customId.replace('ticket_open_', '');
  const btnDef = g.tickets.buttons.find((b) => b.id === btnId);
  if (!btnDef) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: '❌ Ce bouton n\'est plus configuré.' });
    return;
  }

  const alreadyOpen = Object.entries(g.tickets.open).find(([, t]) => t.userId === interaction.user.id && t.buttonId === btnId);
  if (alreadyOpen) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: `❌ Tu as déjà un ticket **${btnDef.label}** ouvert : <#${alreadyOpen[0]}>` });
    return;
  }

  if (btnDef.questions?.length > 0) {
    const modal = new ModalBuilder().setCustomId(`ticket_modal_${btnId}`).setTitle(`🎫 ${btnDef.label}`);
    modal.addComponents(
      ...btnDef.questions.slice(0, 5).map((q, i) =>
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId(`q${i}`).setLabel(q.slice(0, 45))
            .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)
        )
      )
    );
    await interaction.showModal(modal);
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const channel = await createTicketChannel(guild, g, interaction.member, btnDef, {});
  if (!channel) { await interaction.editReply('❌ Impossible de créer le salon. Vérifie les permissions du bot.'); return; }
  await interaction.editReply(`✅ Ticket ouvert : <#${channel.id}>`);
}

// ----------------------------------------------------------------
// HANDLER MODAL QUESTIONS (panel public)
// ----------------------------------------------------------------
async function handleTicketModal(interaction, client) {
  const guild = interaction.guild;
  const g = db.get(guild.id);
  ensureTickets(g);

  const btnId = interaction.customId.replace('ticket_modal_', '');
  const btnDef = g.tickets.buttons.find((b) => b.id === btnId);
  if (!btnDef) { await interaction.reply({ flags: MessageFlags.Ephemeral, content: '❌ Bouton introuvable.' }); return; }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const answers = {};
  (btnDef.questions || []).forEach((q, i) => { answers[q] = interaction.fields.getTextInputValue(`q${i}`); });

  const channel = await createTicketChannel(guild, g, interaction.member, btnDef, answers);
  if (!channel) { await interaction.editReply('❌ Impossible de créer le salon.'); return; }
  await interaction.editReply(`✅ Ticket ouvert : <#${channel.id}>`);
}

// ----------------------------------------------------------------
// CRÉER LE SALON TICKET
// ----------------------------------------------------------------
async function createTicketChannel(guild, g, member, btnDef, answers) {
  ensureTickets(g);
  g.tickets.counter = (g.tickets.counter || 0) + 1;
  const num = String(g.tickets.counter).padStart(4, '0');
  const channelName = `ticket-${num}-${member.user.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'membre'}`;

  const permOverwrites = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    { id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] },
  ];
  if (g.tickets.staffRoleId) {
    permOverwrites.push({ id: g.tickets.staffRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] });
  }

  let channel;
  try {
    channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: g.tickets.categoryId || null,
      permissionOverwrites: permOverwrites,
      reason: `Ticket #${num} — ${member.user.tag}`,
    });
  } catch { return null; }

  g.tickets.open[channel.id] = { userId: member.id, buttonId: btnDef.id, buttonLabel: btnDef.label, answers, openedAt: Date.now(), ticketNum: num };
  await db.save(guild.id);

  const embed = new EmbedBuilder()
    .setTitle(`🎫 Ticket #${num} — ${btnDef.label}`)
    .setColor(hexToInt(g.tickets.color))
    .setDescription(`Ticket ouvert par <@${member.id}>`)
    .setTimestamp();

  if (Object.keys(answers).length) {
    embed.addFields(Object.entries(answers).map(([q, a]) => ({ name: `❓ ${q}`, value: a || '*(vide)*', inline: false })));
  }

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_close_${channel.id}`).setLabel('🔒 Fermer le ticket').setStyle(ButtonStyle.Danger)
  );

  const staffMention = g.tickets.staffRoleId ? `<@&${g.tickets.staffRoleId}>` : '';
  await channel.send({ content: `${member} ${staffMention}`.trim(), embeds: [embed], components: [closeRow] });
  return channel;
}

// ----------------------------------------------------------------
// HANDLER BOUTON FERMER TICKET
// ----------------------------------------------------------------
async function handleCloseButton(interaction, client) {
  const guild = interaction.guild;
  const g = db.get(guild.id);
  ensureTickets(g);

  const channelId = interaction.customId.replace('ticket_close_', '');
  const ticketData = g.tickets.open[channelId];

  const isStaff = interaction.member.permissions.has(PermissionFlagsBits.ManageChannels) ||
    (g.tickets.staffRoleId && interaction.member.roles.cache.has(g.tickets.staffRoleId));
  const isOwner = ticketData?.userId === interaction.user.id;
  if (!isStaff && !isOwner) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: '❌ Seul le staff ou l\'auteur du ticket peut le fermer.' });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (ticketData && g.tickets.logChannelId) {
    try {
      const logChannel = guild.channels.cache.get(g.tickets.logChannelId);
      if (logChannel) {
        const duration = ticketData.openedAt ? Math.round((Date.now() - ticketData.openedAt) / 60000) : '?';
        const logEmbed = new EmbedBuilder()
          .setTitle(`🔒 Ticket #${ticketData.ticketNum || '?'} fermé — ${ticketData.buttonLabel || ''}`)
          .setColor(0x888888)
          .addFields(
            { name: 'Ouvert par', value: `<@${ticketData.userId}>`, inline: true },
            { name: 'Fermé par', value: `<@${interaction.user.id}>`, inline: true },
            { name: 'Durée', value: `${duration} min`, inline: true },
          ).setTimestamp();
        if (ticketData.answers && Object.keys(ticketData.answers).length) {
          logEmbed.addFields(Object.entries(ticketData.answers).map(([q, a]) => ({ name: `❓ ${q}`, value: a || '*(vide)*', inline: false })));
        }
        await logChannel.send({ embeds: [logEmbed] });
      }
    } catch {}
  }

  delete g.tickets.open[channelId];
  await db.save(guild.id);

  try {
    const ch = guild.channels.cache.get(channelId);
    if (ch) {
      await ch.send('🔒 Ticket fermé. Ce salon sera supprimé dans 5 secondes...');
      await new Promise((r) => setTimeout(r, 5000));
      await ch.delete('Ticket fermé');
    }
  } catch {}

  try { await interaction.editReply('✅ Ticket fermé.'); } catch {}
}

// ----------------------------------------------------------------
// EXPORTS
// ----------------------------------------------------------------
module.exports = { commands, isTicketCommand, handleCommand, handleSetupButton, handleSetupModal, handleOpenButton, handleCloseButton, handleTicketModal };
