// ================================================================
// tickets.js — Système de tickets multi-panel (un panel par salon)
//
// Structure DB par serveur :
//   g.ticketPanels[channelId] = {
//     title, description, color,
//     staffRoleId, logChannelId, categoryId,
//     embedMessageId,
//     buttons[] : { id, label, emoji, color, questions[] }
//   }
//   g.ticketsOpen[channelId]  = { userId, panelChannelId, buttonId, buttonLabel, answers, openedAt, ticketNum }
//   g.ticketsCounter          : numéro incrémental global
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

// Assure que les champs globaux (tickets ouverts, compteur) existent.
function ensureGlobal(g) {
  if (!g.ticketsOpen || typeof g.ticketsOpen !== 'object') g.ticketsOpen = {};
  if (!g.ticketsCounter) g.ticketsCounter = 0;
}

// Retourne (et initialise si besoin) le panel d'un salon donné.
function getPanel(g, channelId) {
  if (!g.ticketPanels || typeof g.ticketPanels !== 'object') g.ticketPanels = {};
  if (!g.ticketPanels[channelId]) {
    g.ticketPanels[channelId] = {
      title: '🎫 Support',
      description: 'Clique sur un bouton ci-dessous pour ouvrir un ticket.',
      color: '#5865F2',
      buttons: [],
    };
  }
  const p = g.ticketPanels[channelId];
  if (!Array.isArray(p.buttons)) p.buttons = [];
  return p;
}

function hexToInt(hex) {
  if (!hex) return 0x5865F2;
  const n = parseInt(hex.replace('#', ''), 16);
  return isNaN(n) ? 0x5865F2 : n;
}

// Mappe une couleur hex vers le ButtonStyle Discord le plus proche.
// Discord n'accepte que 4 couleurs — on choisit la plus proche en RGB.
function hexToButtonStyle(hex) {
  if (!hex) return ButtonStyle.Primary;
  const raw = hex.replace('#', '');
  const r = parseInt(raw.slice(0, 2), 16) || 0;
  const g = parseInt(raw.slice(2, 4), 16) || 0;
  const b = parseInt(raw.slice(4, 6), 16) || 0;
  // Couleurs de référence Discord
  const targets = [
    { style: ButtonStyle.Primary,   r: 88,  g: 101, b: 242 }, // bleu
    { style: ButtonStyle.Secondary, r: 79,  g: 84,  b: 92  }, // gris
    { style: ButtonStyle.Success,   r: 87,  g: 180, b: 111 }, // vert
    { style: ButtonStyle.Danger,    r: 237, g: 66,  b: 69  }, // rouge
  ];
  let best = ButtonStyle.Primary, bestDist = Infinity;
  for (const t of targets) {
    const dist = (r - t.r) ** 2 + (g - t.g) ** 2 + (b - t.b) ** 2;
    if (dist < bestDist) { bestDist = dist; best = t.style; }
  }
  return best;
}

// ----------------------------------------------------------------
// BUILDERS EMBED / MENU
// ----------------------------------------------------------------

function buildPreviewEmbed(p, channelId) {
  const embed = new EmbedBuilder()
    .setTitle(p.title)
    .setDescription(p.description)
    .setColor(hexToInt(p.color))
    .setFooter({ text: 'Aperçu — ceci est à quoi ressemblera l\'embed public.' });

  if (p.buttons.length) {
    embed.addFields({
      name: `Boutons configurés (${p.buttons.length})`,
      value: p.buttons.map((b) => `${b.emoji || '•'} **${b.label}**${b.questions?.length ? ` — ${b.questions.length} question(s)` : ''} \`${b.color || '#5865F2'}\``).join('\n'),
    });
  } else {
    embed.addFields({ name: 'Boutons', value: '*Aucun bouton — ajoutes-en via le menu ci-dessous.*' });
  }

  const cfg = [];
  if (p.logChannelId) cfg.push(`📋 Logs : <#${p.logChannelId}>`);
  if (p.categoryId) cfg.push(`📁 Catégorie : <#${p.categoryId}>`);
  if (cfg.length) embed.addFields({ name: 'Configuration', value: cfg.join('\n') });

  return embed;
}

function buildPanelRows(p) {
  const btns = p.buttons.slice(0, 25);
  const rows = [];
  for (let i = 0; i < btns.length; i += 5) {
    const row = new ActionRowBuilder().addComponents(
      btns.slice(i, i + 5).map((b) => {
        const btn = new ButtonBuilder()
          .setCustomId(`ticket_open_${b.id}`)
          .setLabel(b.label)
          .setStyle(hexToButtonStyle(b.color));
        if (b.emoji) try { btn.setEmoji(b.emoji); } catch {}
        return btn;
      })
    );
    rows.push(row);
  }
  return rows;
}

function buildPanelEmbed(p) {
  return new EmbedBuilder()
    .setTitle(p.title)
    .setDescription(p.description)
    .setColor(hexToInt(p.color))
    .setFooter({ text: 'Ouvre un ticket en cliquant sur un bouton.' });
}

function buildSetupMenu(p) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tsetup_edit_embed').setLabel('✏️ Modifier titre / description').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tsetup_edit_color').setLabel('🎨 Couleur embed').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tsetup_edit_config').setLabel('⚙️ Logs / Catégorie').setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tsetup_add_btn').setLabel('➕ Ajouter un bouton').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('tsetup_remove_btn').setLabel('➖ Supprimer un bouton').setStyle(ButtonStyle.Danger)
      .setDisabled(!p.buttons.length),
    new ButtonBuilder().setCustomId('tsetup_list_btns').setLabel('📋 Voir les boutons').setStyle(ButtonStyle.Secondary)
      .setDisabled(!p.buttons.length),
  );
  // Configurer les boutons accept/refuse sur un type de ticket
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tsetup_edit_ticket_embed').setLabel('📝 Modifier l\'embed du ticket').setStyle(ButtonStyle.Secondary)
      .setDisabled(!p.buttons.length),
    new ButtonBuilder().setCustomId('tsetup_config_accept_refuse').setLabel('✅❌ Config Accepter / Refuser').setStyle(ButtonStyle.Secondary)
      .setDisabled(!p.buttons.length),
  );
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tsetup_post').setLabel('📢 Poster l\'embed').setStyle(ButtonStyle.Primary)
      .setDisabled(!p.buttons.length),
    new ButtonBuilder().setCustomId('tsetup_close').setLabel('✅ Terminer').setStyle(ButtonStyle.Secondary),
  );
  return [row1, row2, row3, row4];
}

// ----------------------------------------------------------------
// COMMANDES SLASH
// ----------------------------------------------------------------
const commands = [
  new SlashCommandBuilder().setName('ticket')
    .setDescription('(Admin) Configurer le panel de tickets de ce salon'),
].map((c) => c.setDMPermission(false).toJSON());

// ----------------------------------------------------------------
// HANDLER /ticket
// ----------------------------------------------------------------
async function handleCommand(interaction, client) {
  const guild = interaction.guild;
  const g = db.get(guild.id);
  ensureGlobal(g);

  const member = interaction.member;
  const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator) ||
                  member.permissions.has(PermissionFlagsBits.ManageGuild) ||
                  guild.ownerId === member.id;
  if (!isAdmin) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: '❌ Seuls les Administrateurs / Gérer le serveur peuvent configurer les tickets.' });
    return;
  }

  // Chaque salon a son propre panel — on stocke le channelId dans le customId du menu.
  const channelId = interaction.channelId;
  const p = getPanel(g, channelId);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const embed = buildPreviewEmbed(p, channelId);
  const rows = buildSetupMenu(p);
  await interaction.editReply({ embeds: [embed], components: rows, flags: MessageFlags.Ephemeral });
}

// ----------------------------------------------------------------
// HANDLER BOUTONS SETUP
// ----------------------------------------------------------------
async function handleSetupButton(interaction, client) {
  const guild = interaction.guild;
  const g = db.get(guild.id);
  ensureGlobal(g);
  const channelId = interaction.channelId;
  const p = getPanel(g, channelId);
  const id = interaction.customId;

  if (id === 'tsetup_edit_embed') {
    const modal = new ModalBuilder().setCustomId('tsetup_modal_embed').setTitle('Modifier l\'embed');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('title').setLabel('Titre').setStyle(TextInputStyle.Short)
          .setValue(p.title).setRequired(true).setMaxLength(100)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('desc').setLabel('Description').setStyle(TextInputStyle.Paragraph)
          .setValue(p.description).setRequired(true).setMaxLength(1000)
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (id === 'tsetup_edit_color') {
    const modal = new ModalBuilder().setCustomId('tsetup_modal_color').setTitle('Couleur de l\'embed');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('color').setLabel('Couleur hex (ex: #FF5500)').setStyle(TextInputStyle.Short)
          .setValue(p.color || '#5865F2').setRequired(true).setMaxLength(7)
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (id === 'tsetup_edit_config') {
    const modal = new ModalBuilder().setCustomId('tsetup_modal_config').setTitle('Logs / Catégorie');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('logs').setLabel('ID salon logs (optionnel)').setStyle(TextInputStyle.Short)
          .setValue(p.logChannelId || '').setRequired(false).setPlaceholder('Laisse vide pour désactiver')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('category').setLabel('ID catégorie pour les tickets').setStyle(TextInputStyle.Short)
          .setValue(p.categoryId || '').setRequired(false).setPlaceholder('ID de la catégorie Discord')
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (id === 'tsetup_add_btn') {
    if (p.buttons.length >= 25) {
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
        new TextInputBuilder().setCustomId('btn_color').setLabel('Couleur hex (ex: #FF0000)').setStyle(TextInputStyle.Short)
          .setValue('#5865F2').setRequired(false).setMaxLength(7)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('btn_questions').setLabel('Questions séparées par ; (optionnel)').setStyle(TextInputStyle.Paragraph)
          .setRequired(false).setMaxLength(500).setPlaceholder('Ton pseudo;Ton problème;Depuis quand?')
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (id === 'tsetup_remove_btn') {
    const modal = new ModalBuilder().setCustomId('tsetup_modal_removebtn').setTitle('Supprimer un bouton');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('nom').setLabel('Nom exact du bouton à supprimer').setStyle(TextInputStyle.Short)
          .setRequired(true).setMaxLength(80).setPlaceholder(p.buttons[0]?.label || 'Nom du bouton')
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (id === 'tsetup_list_btns') {
    const lines = p.buttons.map((b, i) => {
      const qs = b.questions?.length ? b.questions.map((q) => `\n    ❓ ${q}`).join('') : ' *(aucune question)*';
      return `**${i + 1}.** ${b.emoji || ''} ${b.label} \`${b.color || '#5865F2'}\`${qs}`;
    });
    await interaction.deferUpdate();
    await interaction.followUp({ flags: MessageFlags.Ephemeral, content: lines.join('\n\n') || 'Aucun bouton.' });
    return;
  }

  if (id === 'tsetup_post') {
    await interaction.deferUpdate();
    const targetChannel = interaction.channel;
    const rows = buildPanelRows(p);
    if (!rows.length) {
      await interaction.followUp({ flags: MessageFlags.Ephemeral, content: '❌ Aucun bouton configuré.' });
      return;
    }
    try {
      if (p.embedMessageId) {
        try { await targetChannel.messages.fetch(p.embedMessageId).then((m) => m.delete()); } catch {}
      }
      const msg = await targetChannel.send({ embeds: [buildPanelEmbed(p)], components: rows });
      p.embedMessageId = msg.id;
      await db.save(guild.id);
      await interaction.followUp({ flags: MessageFlags.Ephemeral, content: `✅ Embed posté dans <#${targetChannel.id}> !` });
    } catch (e) {
      await interaction.followUp({ flags: MessageFlags.Ephemeral, content: `❌ Erreur : ${e.message}` });
    }
    return;
  }

  if (id === 'tsetup_edit_ticket_embed') {
    // Choisir quel bouton éditer (par nom)
    const modal = new ModalBuilder().setCustomId('tsetup_modal_ticket_embed').setTitle('Modifier l\'embed d\'ouverture');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('btn_target').setLabel('Nom exact du bouton ciblé').setStyle(TextInputStyle.Short)
          .setRequired(true).setMaxLength(80).setPlaceholder(p.buttons[0]?.label || 'Staff Application')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('embed_title').setLabel('Titre de l\'embed (optionnel)').setStyle(TextInputStyle.Short)
          .setRequired(false).setMaxLength(100).setPlaceholder('Laisse vide pour garder le titre par défaut')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('embed_desc').setLabel('Description de l\'embed (optionnel)').setStyle(TextInputStyle.Paragraph)
          .setRequired(false).setMaxLength(2000).setPlaceholder('Laisse vide pour garder la description par défaut')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('embed_color').setLabel('Couleur hex (optionnel, ex: #FF5500)').setStyle(TextInputStyle.Short)
          .setRequired(false).setMaxLength(7).setPlaceholder('Laisse vide pour la couleur du panel')
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (id === 'tsetup_config_accept_refuse') {
    const modal = new ModalBuilder().setCustomId('tsetup_modal_accept_refuse').setTitle('Configurer Accepter / Refuser');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('btn_target').setLabel('Nom exact du bouton ciblé').setStyle(TextInputStyle.Short)
          .setRequired(true).setMaxLength(80).setPlaceholder(p.buttons[0]?.label || 'Staff Application')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('accept_role_id').setLabel('ID du rôle à donner si accepté').setStyle(TextInputStyle.Short)
          .setRequired(false).setMaxLength(25).setPlaceholder('Laisse vide pour désactiver l\'acceptation')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('refuse_enabled').setLabel('Activer le bouton Refuser ? (oui/non)').setStyle(TextInputStyle.Short)
          .setRequired(true).setMaxLength(3).setValue('oui')
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (id === 'tsetup_close') {
    await interaction.update({ content: '✅ Configuration terminée.', embeds: [], components: [] });
    return;
  }
}

// ----------------------------------------------------------------
// HANDLER MODALS SETUP
// ----------------------------------------------------------------
async function handleSetupModal(interaction, client) {
  const guild = interaction.guild;
  const g = db.get(guild.id);
  ensureGlobal(g);
  const channelId = interaction.channelId;
  const p = getPanel(g, channelId);
  const id = interaction.customId;

  async function refreshSetup(errorMsg) {
    if (errorMsg) {
      await interaction.reply({ flags: MessageFlags.Ephemeral, content: errorMsg, embeds: [], components: [] });
      return;
    }
    await interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [buildPreviewEmbed(p, channelId)], components: buildSetupMenu(p) });
  }

  if (id === 'tsetup_modal_embed') {
    p.title = interaction.fields.getTextInputValue('title');
    p.description = interaction.fields.getTextInputValue('desc');
    await db.save(guild.id);
    await refreshSetup();
    return;
  }

  if (id === 'tsetup_modal_color') {
    const c = interaction.fields.getTextInputValue('color').trim();
    if (!/^#?[0-9a-fA-F]{6}$/.test(c)) { await refreshSetup('❌ Couleur invalide. Format : `#FF5500`'); return; }
    p.color = c.startsWith('#') ? c : `#${c}`;
    await db.save(guild.id);
    await refreshSetup();
    return;
  }

  if (id === 'tsetup_modal_config') {
    const logs = interaction.fields.getTextInputValue('logs').trim();
    const category = interaction.fields.getTextInputValue('category').trim();

    if (logs) {
      const lc = guild.channels.cache.get(logs);
      if (!lc) { await refreshSetup(`❌ Salon logs introuvable : \`${logs}\``); return; }
      p.logChannelId = logs;
    } else { delete p.logChannelId; }

    if (category) {
      const cat = guild.channels.cache.get(category);
      if (!cat) { await refreshSetup(`❌ Catégorie introuvable : \`${category}\``); return; }
      p.categoryId = category;
    } else { delete p.categoryId; }

    await db.save(guild.id);
    await refreshSetup();
    return;
  }

  if (id === 'tsetup_modal_addbtn') {
    const label = interaction.fields.getTextInputValue('btn_label').trim();
    const emoji = interaction.fields.getTextInputValue('btn_emoji').trim() || null;
    const colorRaw = interaction.fields.getTextInputValue('btn_color').trim();
    const questionsRaw = interaction.fields.getTextInputValue('btn_questions').trim();

    const color = /^#?[0-9a-fA-F]{6}$/.test(colorRaw)
      ? (colorRaw.startsWith('#') ? colorRaw : `#${colorRaw}`)
      : '#5865F2';
    const questions = questionsRaw ? questionsRaw.split(';').map((q) => q.trim()).filter(Boolean).slice(0, 5) : [];
    const btnId = `btn_${Date.now().toString(36)}`;

    p.buttons.push({ id: btnId, label, emoji, color, questions });
    await db.save(guild.id);
    await refreshSetup();
    return;
  }

  if (id === 'tsetup_modal_removebtn') {
    const nom = interaction.fields.getTextInputValue('nom').toLowerCase().trim();
    const before = p.buttons.length;
    p.buttons = p.buttons.filter((b) => b.label.toLowerCase() !== nom);
    if (p.buttons.length === before) { await refreshSetup(`❌ Bouton \`${nom}\` introuvable.`); return; }
    await db.save(guild.id);
    await refreshSetup();
    return;
  }

  // ---- Modifier l'embed d'ouverture d'un bouton spécifique ----
  if (id === 'tsetup_modal_ticket_embed') {
    const target = interaction.fields.getTextInputValue('btn_target').trim();
    const btn = p.buttons.find((b) => b.label.toLowerCase() === target.toLowerCase());
    if (!btn) { await refreshSetup(`❌ Bouton \`${target}\` introuvable.`); return; }

    const newTitle = interaction.fields.getTextInputValue('embed_title').trim();
    const newDesc  = interaction.fields.getTextInputValue('embed_desc').trim();
    const newColor = interaction.fields.getTextInputValue('embed_color').trim();

    if (!btn.ticketEmbed) btn.ticketEmbed = {};
    if (newTitle) btn.ticketEmbed.title = newTitle;
    if (newDesc)  btn.ticketEmbed.description = newDesc;
    if (newColor && /^#?[0-9a-fA-F]{6}$/.test(newColor)) {
      btn.ticketEmbed.color = newColor.startsWith('#') ? newColor : `#${newColor}`;
    }

    await db.save(guild.id);
    await refreshSetup(`✅ Embed du ticket **${btn.label}** mis à jour.`);
    return;
  }

  // ---- Configurer accept/refuse pour un bouton ----
  if (id === 'tsetup_modal_accept_refuse') {
    const target = interaction.fields.getTextInputValue('btn_target').trim();
    const btn = p.buttons.find((b) => b.label.toLowerCase() === target.toLowerCase());
    if (!btn) { await refreshSetup(`❌ Bouton \`${target}\` introuvable.`); return; }

    const roleId = interaction.fields.getTextInputValue('accept_role_id').trim();
    const refuseRaw = interaction.fields.getTextInputValue('refuse_enabled').trim().toLowerCase();
    const refuseEnabled = refuseRaw === 'oui' || refuseRaw === 'yes' || refuseRaw === '1';

    if (!btn.acceptRefuse) btn.acceptRefuse = {};

    if (roleId) {
      const role = guild.roles.cache.get(roleId);
      if (!role) { await refreshSetup(`❌ Rôle introuvable : \`${roleId}\``); return; }
      btn.acceptRefuse.roleId = roleId;
      btn.acceptRefuse.acceptEnabled = true;
    } else {
      btn.acceptRefuse.acceptEnabled = false;
      delete btn.acceptRefuse.roleId;
    }

    btn.acceptRefuse.refuseEnabled = refuseEnabled;

    await db.save(guild.id);
    const acceptStr = btn.acceptRefuse.acceptEnabled ? `✅ Accepter → rôle <@&${btn.acceptRefuse.roleId}>` : '✅ Accepter désactivé';
    const refuseStr = refuseEnabled ? '❌ Refuser activé' : '❌ Refuser désactivé';
    await refreshSetup(`✅ Bouton **${btn.label}** configuré :\n${acceptStr}\n${refuseStr}`);
    return;
  }
}

// ----------------------------------------------------------------
// HANDLER BOUTON OUVERTURE TICKET (panel public)
// ----------------------------------------------------------------
async function handleOpenButton(interaction, client) {
  const guild = interaction.guild;
  const g = db.get(guild.id);
  ensureGlobal(g);

  const btnId = interaction.customId.replace('ticket_open_', '');

  // Retrouver le panel qui contient ce bouton
  let panelChannelId = null;
  let btnDef = null;
  for (const [chId, p] of Object.entries(g.ticketPanels || {})) {
    const found = p.buttons?.find((b) => b.id === btnId);
    if (found) { panelChannelId = chId; btnDef = found; break; }
  }

  if (!btnDef) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: '❌ Ce bouton n\'est plus configuré.' });
    return;
  }

  const p = g.ticketPanels[panelChannelId];

  const alreadyOpen = Object.entries(g.ticketsOpen).find(([, t]) => t.userId === interaction.user.id && t.buttonId === btnId);
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
  const channel = await createTicketChannel(guild, g, p, interaction.member, btnDef, {}, panelChannelId);
  if (!channel) { await interaction.editReply('❌ Impossible de créer le salon. Vérifie les permissions du bot.'); return; }
  await interaction.editReply(`✅ Ticket ouvert : <#${channel.id}>`);
}

// ----------------------------------------------------------------
// HANDLER MODAL QUESTIONS (panel public)
// ----------------------------------------------------------------
async function handleTicketModal(interaction, client) {
  const guild = interaction.guild;
  const g = db.get(guild.id);
  ensureGlobal(g);

  const btnId = interaction.customId.replace('ticket_modal_', '');

  let panelChannelId = null;
  let btnDef = null;
  for (const [chId, p] of Object.entries(g.ticketPanels || {})) {
    const found = p.buttons?.find((b) => b.id === btnId);
    if (found) { panelChannelId = chId; btnDef = found; break; }
  }

  if (!btnDef) { await interaction.reply({ flags: MessageFlags.Ephemeral, content: '❌ Bouton introuvable.' }); return; }
  const p = g.ticketPanels[panelChannelId];

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const answers = {};
  (btnDef.questions || []).forEach((q, i) => { answers[q] = interaction.fields.getTextInputValue(`q${i}`); });

  const channel = await createTicketChannel(guild, g, p, interaction.member, btnDef, answers, panelChannelId);
  if (!channel) { await interaction.editReply('❌ Impossible de créer le salon.'); return; }
  await interaction.editReply(`✅ Ticket ouvert : <#${channel.id}>`);
}

// ----------------------------------------------------------------
// CRÉER LE SALON TICKET
// ----------------------------------------------------------------
async function createTicketChannel(guild, g, p, member, btnDef, answers, panelChannelId) {
  ensureGlobal(g);
  g.ticketsCounter = (g.ticketsCounter || 0) + 1;
  const num = String(g.ticketsCounter).padStart(4, '0');
  const channelName = `ticket-${num}-${member.user.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'membre'}`;

  const permOverwrites = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    { id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] },
  ];
  if (p.staffRoleId) {
    permOverwrites.push({ id: p.staffRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] });
  }

  let channel;
  try {
    channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: p.categoryId || null,
      permissionOverwrites: permOverwrites,
      reason: `Ticket #${num} — ${member.user.tag}`,
    });
  } catch { return null; }

  g.ticketsOpen[channel.id] = { userId: member.id, panelChannelId: panelChannelId || null, buttonId: btnDef.id, buttonLabel: btnDef.label, answers, openedAt: Date.now(), ticketNum: num };
  await db.save(guild.id);

  // Embed: utilise les overrides du bouton si définis, sinon valeurs par défaut
  const te = btnDef.ticketEmbed || {};
  const embed = new EmbedBuilder()
    .setTitle(te.title || `🎫 Ticket #${num} — ${btnDef.label}`)
    .setColor(hexToInt(te.color || p.color))
    .setDescription((te.description ? `${te.description}\n\n` : '') + `Ticket ouvert par <@${member.id}>`)
    .setTimestamp();

  if (Object.keys(answers).length) {
    embed.addFields(Object.entries(answers).map(([q, a]) => ({ name: `❓ ${q}`, value: a || '*(vide)*', inline: false })));
  }

  // Construire la rangée de boutons d'action
  const actionButtons = [
    new ButtonBuilder().setCustomId(`ticket_close_${channel.id}`).setLabel('🔒 Fermer le ticket').setStyle(ButtonStyle.Danger),
  ];

  const ar = btnDef.acceptRefuse || {};
  if (ar.acceptEnabled && ar.roleId) {
    actionButtons.push(
      new ButtonBuilder()
        .setCustomId(`ticket_accept_${channel.id}`)
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success)   // vert
    );
  }
  if (ar.refuseEnabled) {
    actionButtons.push(
      new ButtonBuilder()
        .setCustomId(`ticket_refuse_${channel.id}`)
        .setEmoji('❌')
        .setStyle(ButtonStyle.Secondary) // noir/gris foncé
    );
  }

  const closeRow = new ActionRowBuilder().addComponents(...actionButtons);

  const staffMention = p.staffRoleId ? `<@&${p.staffRoleId}>` : '';
  await channel.send({ content: `${member} ${staffMention}`.trim(), embeds: [embed], components: [closeRow] });
  return channel;
}

// ----------------------------------------------------------------
// HANDLER FERMER TICKET
// ----------------------------------------------------------------
async function handleCloseButton(interaction, client) {
  const guild = interaction.guild;
  const g = db.get(guild.id);
  ensureGlobal(g);

  const channelId = interaction.customId.replace('ticket_close_', '');
  const ticketData = g.ticketsOpen[channelId];

  // Retrouver le panel d'origine pour les infos staff/logs
  let p = null;
  if (ticketData?.panelChannelId && g.ticketPanels?.[ticketData.panelChannelId]) {
    p = g.ticketPanels[ticketData.panelChannelId];
  }

  const isStaff = interaction.member.permissions.has(PermissionFlagsBits.ManageChannels) ||
    (p?.staffRoleId && interaction.member.roles.cache.has(p.staffRoleId));
  const isOwner = ticketData?.userId === interaction.user.id;
  if (!isStaff && !isOwner) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: '❌ Seul le staff ou l\'auteur du ticket peut le fermer.' });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (ticketData && p?.logChannelId) {
    try {
      const logChannel = guild.channels.cache.get(p.logChannelId);
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

  try {
    const ch = guild.channels.cache.get(channelId);
    if (ch) {
      await ch.send('🔒 Ticket fermé. Ce salon sera supprimé dans 5 secondes...');
      await new Promise((r) => setTimeout(r, 5000));
      await ch.delete('Ticket fermé');
    }
  } catch {}

  delete g.ticketsOpen[channelId];
  await db.save(guild.id);

  try { await interaction.editReply('✅ Ticket fermé.'); } catch {}
}

// ----------------------------------------------------------------
// HANDLER ACCEPTER TICKET ✅
// ----------------------------------------------------------------
async function handleAcceptButton(interaction, client) {
  const guild = interaction.guild;
  const g = db.get(guild.id);
  ensureGlobal(g);

  const channelId = interaction.customId.replace('ticket_accept_', '');
  const ticketData = g.ticketsOpen[channelId];
  if (!ticketData) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: '❌ Ticket introuvable en base.' });
    return;
  }

  // Retrouver le panel et la définition du bouton
  let p = null, btnDef = null;
  for (const [, panel] of Object.entries(g.ticketPanels || {})) {
    const found = panel.buttons?.find((b) => b.id === ticketData.buttonId);
    if (found) { p = panel; btnDef = found; break; }
  }

  // Vérif staff
  const isStaff = interaction.member.permissions.has(PermissionFlagsBits.ManageChannels) ||
    (p?.staffRoleId && interaction.member.roles.cache.has(p.staffRoleId));
  if (!isStaff) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: '❌ Only staff can accept applications.' });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const roleId = btnDef?.acceptRefuse?.roleId;
  let roleMention = '';
  if (roleId) {
    try {
      const member = await guild.members.fetch(ticketData.userId);
      await member.roles.add(roleId, `Accepted by ${interaction.user.tag}`);
      roleMention = `<@&${roleId}>`;
    } catch (e) {
      await interaction.editReply(`❌ Could not assign role: ${e.message}`);
      return;
    }
  }

  // Message dans le ticket avant fermeture
  const ch = guild.channels.cache.get(channelId);
  if (ch) {
    const acceptEmbed = new EmbedBuilder()
      .setTitle('✅ Application Accepted')
      .setColor(0x57b85a)
      .setDescription(`<@${ticketData.userId}> your application has been **accepted**!${roleMention ? `\nYou have been given the role ${roleMention}.` : ''}`)
      .setFooter({ text: `Accepted by ${interaction.user.tag}` })
      .setTimestamp();
    await ch.send({ embeds: [acceptEmbed] });
  }

  // Log
  if (p?.logChannelId) {
    try {
      const logChannel = guild.channels.cache.get(p.logChannelId);
      if (logChannel) {
        const logEmbed = new EmbedBuilder()
          .setTitle(`✅ Application Accepted — #${ticketData.ticketNum || '?'} ${ticketData.buttonLabel || ''}`)
          .setColor(0x57b85a)
          .addFields(
            { name: 'Applicant', value: `<@${ticketData.userId}>`, inline: true },
            { name: 'Accepted by', value: `<@${interaction.user.id}>`, inline: true },
            { name: 'Role given', value: roleMention || '*(none)*', inline: true },
          ).setTimestamp();
        if (ticketData.answers && Object.keys(ticketData.answers).length) {
          logEmbed.addFields(Object.entries(ticketData.answers).map(([q, a]) => ({ name: `❓ ${q}`, value: a || '*(vide)*', inline: false })));
        }
        await logChannel.send({ embeds: [logEmbed] });
      }
    } catch {}
  }

  // Fermer le ticket après délai
  if (ch) {
    await ch.send('✅ This ticket will be closed in 5 seconds...');
    await new Promise((r) => setTimeout(r, 5000));
    try { await ch.delete('Application accepted'); } catch {}
  }

  delete g.ticketsOpen[channelId];
  await db.save(guild.id);
  try { await interaction.editReply('✅ Application accepted.'); } catch {}
}

// ----------------------------------------------------------------
// HANDLER REFUSER TICKET ❌
// ----------------------------------------------------------------
async function handleRefuseButton(interaction, client) {
  const guild = interaction.guild;
  const g = db.get(guild.id);
  ensureGlobal(g);

  const channelId = interaction.customId.replace('ticket_refuse_', '');
  const ticketData = g.ticketsOpen[channelId];
  if (!ticketData) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: '❌ Ticket introuvable en base.' });
    return;
  }

  // Retrouver le panel
  let p = null;
  for (const [, panel] of Object.entries(g.ticketPanels || {})) {
    const found = panel.buttons?.find((b) => b.id === ticketData.buttonId);
    if (found) { p = panel; break; }
  }

  // Vérif staff
  const isStaff = interaction.member.permissions.has(PermissionFlagsBits.ManageChannels) ||
    (p?.staffRoleId && interaction.member.roles.cache.has(p.staffRoleId));
  if (!isStaff) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: '❌ Only staff can refuse applications.' });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Message dans le ticket
  const ch = guild.channels.cache.get(channelId);
  if (ch) {
    const refuseEmbed = new EmbedBuilder()
      .setTitle('❌ Application Declined')
      .setColor(0xed4245)
      .setDescription(`<@${ticketData.userId}> your application has been **declined**.\nThank you for applying. You may apply again in the future.`)
      .setFooter({ text: `Declined by ${interaction.user.tag}` })
      .setTimestamp();
    await ch.send({ embeds: [refuseEmbed] });
  }

  // Log
  if (p?.logChannelId) {
    try {
      const logChannel = guild.channels.cache.get(p.logChannelId);
      if (logChannel) {
        const logEmbed = new EmbedBuilder()
          .setTitle(`❌ Application Declined — #${ticketData.ticketNum || '?'} ${ticketData.buttonLabel || ''}`)
          .setColor(0xed4245)
          .addFields(
            { name: 'Applicant', value: `<@${ticketData.userId}>`, inline: true },
            { name: 'Declined by', value: `<@${interaction.user.id}>`, inline: true },
          ).setTimestamp();
        if (ticketData.answers && Object.keys(ticketData.answers).length) {
          logEmbed.addFields(Object.entries(ticketData.answers).map(([q, a]) => ({ name: `❓ ${q}`, value: a || '*(vide)*', inline: false })));
        }
        await logChannel.send({ embeds: [logEmbed] });
      }
    } catch {}
  }

  // Fermer
  if (ch) {
    await ch.send('❌ This ticket will be closed in 5 seconds...');
    await new Promise((r) => setTimeout(r, 5000));
    try { await ch.delete('Application declined'); } catch {}
  }

  delete g.ticketsOpen[channelId];
  await db.save(guild.id);
  try { await interaction.editReply('✅ Application declined.'); } catch {}
}

// ----------------------------------------------------------------
// EXPORTS
// ----------------------------------------------------------------
module.exports = { commands, isTicketCommand, handleCommand, handleSetupButton, handleSetupModal, handleOpenButton, handleCloseButton, handleTicketModal, handleAcceptButton, handleRefuseButton };
