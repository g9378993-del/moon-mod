const { SlashCommandBuilder, ChannelType, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('buildmode')
    .setDescription('Active/désactive le mode construction du serveur')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('createchannel')
    .setDescription('Crée un nouveau salon')
    .addStringOption(o => o.setName('nom').setDescription('Nom du salon').setRequired(true))
    .addStringOption(o => o.setName('type').setDescription('Type: text ou voice').setChoices(
      { name: 'Text', value: 'text' },
      { name: 'Voice', value: 'voice' }
    ).setRequired(false))
    .addChannelOption(o => o.setName('categorie').setDescription('Catégorie parent').setRequired(false))
    .addStringOption(o => o.setName('description').setDescription('Description du salon').setRequired(false))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('deletechannel')
    .setDescription('Supprime un salon')
    .addChannelOption(o => o.setName('salon').setDescription('Le salon à supprimer').setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('copychannels')
    .setDescription('Copie tous les salons d\'un autre serveur')
    .addStringOption(o => o.setName('server_id').setDescription('ID du serveur source').setRequired(true))
    .toJSON(),
];

function isConstructionCommand(commandName) {
  return ['buildmode', 'createchannel', 'deletechannel', 'copychannels'].includes(commandName);
}

async function handleCommand(interaction, client, g, db) {
  try {
    const cmd = interaction.commandName;

    if (cmd === 'buildmode') {
      g.constructionMode = !g.constructionMode;
      await db.updateGuild(interaction.guildId, { constructionMode: g.constructionMode });
      await interaction.editReply({
        content: `🏗️ Mode construction: **${g.constructionMode ? 'ACTIVÉ ✅' : 'DÉSACTIVÉ ❌'}**`,
      });
    }

    if (cmd === 'createchannel') {
      const nom = interaction.options.getString('nom');
      const type = interaction.options.getString('type') || 'text';
      const categorie = interaction.options.getChannel('categorie');
      const desc = interaction.options.getString('description');

      const channelType = type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText;
      const channel = await interaction.guild.channels.create({
        name: nom,
        type: channelType,
        parent: categorie?.id || null,
        topic: desc || null,
      });

      await interaction.editReply({
        content: `✅ Salon créé: <#${channel.id}>`,
      });
    }

    if (cmd === 'deletechannel') {
      const channel = interaction.options.getChannel('salon');

      if (!channel.deletable) {
        await interaction.editReply({ content: '❌ Impossible de supprimer ce salon (permissions).' });
        return;
      }

      const confirm = new ButtonBuilder()
        .setCustomId(`delete_confirm_${channel.id}`)
        .setLabel('Confirmer')
        .setStyle(ButtonStyle.Danger);

      const cancel = new ButtonBuilder()
        .setCustomId(`delete_cancel_${channel.id}`)
        .setLabel('Annuler')
        .setStyle(ButtonStyle.Secondary);

      const row = new ActionRowBuilder().addComponents(confirm, cancel);

      await interaction.editReply({
        content: `⚠️ Supprimer **#${channel.name}**? (30 secondes pour répondre)`,
        components: [row],
      });

      setTimeout(async () => {
        try {
          await interaction.editReply({ components: [] });
        } catch (e) {}
      }, 30000);
    }

    if (cmd === 'copychannels') {
      const serverId = interaction.options.getString('server_id');
      const sourceGuild = await client.guilds.fetch(serverId).catch(() => null);

      if (!sourceGuild) {
        await interaction.editReply({ content: '❌ Serveur introuvable ou bot pas dedans.' });
        return;
      }

      const channels = sourceGuild.channels.cache.filter(c => c.isTextBased() || c.isVoiceBased());
      let created = 0;

      for (const [, ch] of channels) {
        try {
          const type = ch.isTextBased() ? ChannelType.GuildText : ChannelType.GuildVoice;
          await interaction.guild.channels.create({
            name: ch.name,
            type: type,
            topic: ch.topic || null,
          });
          created++;
        } catch (e) {}
      }

      await interaction.editReply({
        content: `✅ ${created} salon(s) copiés depuis **${sourceGuild.name}**.`,
      });
    }
  } catch (err) {
    console.error('Construction command error:', err);
    await interaction.editReply({ content: '❌ Erreur lors de l\'exécution de la commande.' }).catch(() => {});
  }
}

module.exports = {
  commands,
  isConstructionCommand,
  handleCommand,
};
