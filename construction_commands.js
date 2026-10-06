/**
 * Construction Commands : gestion complète des salons
 * - /buildmode : active/désactive le mode construction
 * - /createchannel : crée un salon avec description, catégorie, permissions
 * - /deletechannel : supprime un salon avec confirmation
 * - /copychannels : copie les salons d'un autre serveur (ID requis)
 */

const {
  SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType,
} = require('discord.js');

// Exporte les SlashCommandBuilder pour registration dans index.js
const commands = [
  new SlashCommandBuilder()
    .setName('buildmode')
    .setDescription('Active/désactive le mode construction du serveur')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('createchannel')
    .setDescription('Crée un nouveau salon')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption((o) =>
      o.setName('nom').setDescription('Nom du salon').setRequired(true)
    )
    .addStringOption((o) =>
      o.setName('type').setDescription('Type de salon')
        .setRequired(false)
        .addChoices(
          { name: 'Texte', value: 'text' },
          { name: 'Vocal', value: 'voice' }
        )
    )
    .addChannelOption((o) =>
      o.setName('categorie').setDescription('Catégorie (optionnel)').setRequired(false)
    )
    .addStringOption((o) =>
      o.setName('description').setDescription('Description (texte seulement)').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('deletechannel')
    .setDescription('Supprime un salon après confirmation')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((o) =>
      o.setName('salon').setDescription('Le salon à supprimer').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('copychannels')
    .setDescription('Copie tous les salons d\'un autre serveur')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((o) =>
      o.setName('server_id').setDescription('ID du serveur à copier').setRequired(true)
    )
    .addBooleanOption((o) =>
      o.setName('with_messages').setDescription('Copier aussi les permissions ? (true/false)').setRequired(false)
    ),
];

// ============================================================
// HANDLERS
// ============================================================

async function handleBuildMode(interaction, g, db) {
  const newState = !g.constructionMode;
  g.constructionMode = newState;
  await db.save(interaction.guildId);

  const embed = new EmbedBuilder()
    .setColor(newState ? 0xFF9900 : 0x00AA00)
    .setTitle(newState ? '🚧 Mode Construction ACTIVÉ' : '✅ Mode Construction DÉSACTIVÉ')
    .setDescription(newState
      ? 'Le serveur est maintenant en mode construction.\nLes membres ne pourront voir que les salons autorisés.'
      : 'Le serveur est revenu à la normale.'
    )
    .setFooter({ text: `Changement appliqué par ${interaction.user.username}` });

  await interaction.editReply({ embeds: [embed] });
}

async function handleCreateChannel(interaction, client, g, db) {
  const nom = interaction.options.getString('nom');
  const typeStr = interaction.options.getString('type') || 'text';
  const categorie = interaction.options.getChannel('categorie');
  const description = interaction.options.getString('description');

  const guild = interaction.guild;
  const type = typeStr === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText;

  try {
    const channelData = {
      name: nom.toLowerCase().replace(/[^a-z0-9-_]/g, '-').slice(0, 100),
      type,
      parent: categorie?.id || null,
    };

    if (type === ChannelType.GuildText && description) {
      channelData.topic = description.slice(0, 1024);
    }

    const channel = await guild.channels.create(channelData);

    const embed = new EmbedBuilder()
      .setColor(0x00AA00)
      .setTitle('✅ Salon créé')
      .setDescription(`<#${channel.id}> a été créé.`)
      .addFields(
        { name: 'Nom', value: channel.name, inline: true },
        { name: 'Type', value: type === ChannelType.GuildVoice ? 'Vocal 🎤' : 'Texte 💬', inline: true },
        ...(categorie ? [{ name: 'Catégorie', value: categorie.name, inline: true }] : []),
        ...(description ? [{ name: 'Description', value: description, inline: false }] : [])
      )
      .setFooter({ text: `Créé par ${interaction.user.username}` });

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply(`❌ Erreur lors de la création : ${err.message}`);
  }
}

async function handleDeleteChannel(interaction, g, db) {
  const channel = interaction.options.getChannel('salon');

  if (!channel) {
    await interaction.editReply('❌ Salon introuvable.');
    return;
  }

  if (!channel.deletable) {
    await interaction.editReply('❌ Je n\'ai pas la permission de supprimer ce salon.');
    return;
  }

  // Confirmation via boutons
  const confirmRow = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`delete_confirm_${channel.id}`)
        .setLabel('✅ Confirmer la suppression')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`delete_cancel_${channel.id}`)
        .setLabel('❌ Annuler')
        .setStyle(ButtonStyle.Secondary)
    );

  const embed = new EmbedBuilder()
    .setColor(0xFF0000)
    .setTitle('⚠️ Êtes-vous sûr ?')
    .setDescription(`Cette action va supprimer le salon <#${channel.id}> définitivement.\nCette action est irréversible.`)
    .setFooter({ text: 'Vous avez 30 secondes pour confirmer.' });

  await interaction.editReply({ embeds: [embed], components: [confirmRow] });

  // Listener pour les boutons (à mettre dans routeSelect() d'index.js)
  // Voir la section "Intégration" plus bas
}

async function handleCopyChannels(interaction, client, g, db) {
  const serverId = interaction.options.getString('server_id');
  const withPerms = interaction.options.getBoolean('with_messages') ?? true;

  let sourceGuild;
  try {
    sourceGuild = await client.guilds.fetch(serverId);
  } catch (err) {
    await interaction.editReply(`❌ Serveur introuvable. Vérifie l'ID (je dois être sur ce serveur).`);
    return;
  }

  if (!sourceGuild) {
    await interaction.editReply(`❌ Je n'ai pas accès au serveur ${serverId}.`);
    return;
  }

  const targetGuild = interaction.guild;
  const channels = sourceGuild.channels.cache
    .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildVoice)
    .sort((a, b) => a.rawPosition - b.rawPosition);

  if (channels.size === 0) {
    await interaction.editReply(`❌ Aucun salon trouvé sur le serveur source.`);
    return;
  }

  await interaction.editReply(`⏳ Copie en cours : ${channels.size} salon(s) à copier...`);

  const results = { success: 0, failed: 0, errors: [] };
  const categoryMap = {}; // sourceId -> targetId pour mapper les catégories

  // Étape 1 : créer les catégories d'abord
  for (const [id, channel] of channels) {
    if (channel.type !== ChannelType.GuildCategory && channel.parent) {
      if (!categoryMap[channel.parent.id]) {
        try {
          const newCategory = await targetGuild.channels.create({
            name: channel.parent.name.toLowerCase().replace(/[^a-z0-9-_]/g, '-'),
            type: ChannelType.GuildCategory,
          });
          categoryMap[channel.parent.id] = newCategory.id;
        } catch (err) {
          results.errors.push(`Catégorie "${channel.parent.name}": ${err.message}`);
        }
      }
    }
  }

  // Étape 2 : créer les salons
  for (const [id, sourceChannel] of channels) {
    if (sourceChannel.type === ChannelType.GuildCategory) continue; // déjà fait

    try {
      const channelData = {
        name: sourceChannel.name.toLowerCase().replace(/[^a-z0-9-_]/g, '-'),
        type: sourceChannel.type,
        parent: categoryMap[sourceChannel.parent?.id] || null,
      };

      if (sourceChannel.type === ChannelType.GuildText && sourceChannel.topic) {
        channelData.topic = sourceChannel.topic;
      }

      // Copier les permissions si demandé
      if (withPerms && sourceChannel.permissionOverwrites) {
        const permissionOverwrites = [];
        for (const [overrideId, override] of sourceChannel.permissionOverwrites.cache) {
          // Exclure les roles de bots managés
          const target = await sourceChannel.guild.members.fetch(overrideId).catch(() => null)
            || sourceChannel.guild.roles.cache.get(overrideId);
          
          if (!target || (target.managed && target.roles)) continue; // skip rôles managés

          // Essayer de trouver l'équivalent sur le serveur cible (par nom)
          let targetId = overrideId;
          if (override.type === 'role') {
            const targetRole = targetGuild.roles.cache.find((r) => r.name === target.name);
            if (targetRole) targetId = targetRole.id;
            else continue; // rôle n'existe pas cible, skip
          }

          permissionOverwrites.push({
            id: targetId,
            type: override.type,
            allow: override.allow,
            deny: override.deny,
          });
        }
        channelData.permissionOverwrites = permissionOverwrites;
      }

      const newChannel = await targetGuild.channels.create(channelData);
      results.success++;
    } catch (err) {
      results.failed++;
      results.errors.push(`"${sourceChannel.name}": ${err.message}`);
    }
  }

  // Résultat
  const embed = new EmbedBuilder()
    .setColor(results.failed === 0 ? 0x00AA00 : 0xFF9900)
    .setTitle(`✅ Copie terminée : ${results.success}/${channels.size}`)
    .setDescription(`Serveur source: **${sourceGuild.name}**\nServeur cible: **${targetGuild.name}**`)
    .addFields(
      { name: '✅ Réussis', value: String(results.success), inline: true },
      { name: '❌ Échoués', value: String(results.failed), inline: true },
      ...(results.errors.length > 0 ? [{ name: '⚠️ Erreurs', value: results.errors.slice(0, 5).join('\n').slice(0, 1024) }] : [])
    )
    .setFooter({ text: `Opération effectuée par ${interaction.user.username}` });

  await interaction.editReply({ embeds: [embed] });
}

// ============================================================
// INTÉGRATION DANS INDEX.JS
// ============================================================
/*
 * 1. Ajoute les commandes à la liste dans index.js (ligne ~316) :
 *
 * const constructionCmds = require('./construction_commands');
 * const commands = [
 *   ... commandes existantes ...
 *   ...constructionCmds.commands
 * ];
 *
 * 2. Dans handleModCommand() (ou routeInteraction si absent), ajoute :
 *
 * if (constructionCmds.isConstructionCommand(interaction.commandName)) {
 *   await constructionCmds.handleCommand(interaction, client, g, db);
 *   return;
 * }
 *
 * 3. Dans routeSelect() pour les confirmations de suppression :
 *
 * if (interaction.customId.startsWith('delete_confirm_')) {
 *   const channelId = interaction.customId.split('_')[2];
 *   const channel = interaction.guild.channels.cache.get(channelId);
 *   if (channel) await channel.delete('Suppression confirmée').catch(() => {});
 *   await interaction.update({ content: '✅ Salon supprimé.', embeds: [], components: [] });
 *   return;
 * }
 * if (interaction.customId.startsWith('delete_cancel_')) {
 *   await interaction.update({ content: '❌ Annulé.', embeds: [], components: [] });
 *   return;
 * }
 */

function isConstructionCommand(cmdName) {
  return ['buildmode', 'createchannel', 'deletechannel', 'copychannels'].includes(cmdName);
}

async function handleCommand(interaction, client, g, db) {
  const cmd = interaction.commandName;

  await interaction.deferReply({ ephemeral: ['buildmode', 'copychannels'].includes(cmd) });

  if (cmd === 'buildmode') await handleBuildMode(interaction, g, db);
  else if (cmd === 'createchannel') await handleCreateChannel(interaction, client, g, db);
  else if (cmd === 'deletechannel') await handleDeleteChannel(interaction, g, db);
  else if (cmd === 'copychannels') await handleCopyChannels(interaction, client, g, db);
}

module.exports = {
  commands,
  isConstructionCommand,
  handleCommand,
};
