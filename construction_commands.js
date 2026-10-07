const { SlashCommandBuilder, ChannelType, ButtonBuilder, ButtonStyle, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('buildmode')
    .setDescription('Toggle server construction mode')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('createchannel')
    .setDescription('Create a new channel')
    .addStringOption(o => o.setName('nom').setDescription('Channel name').setRequired(true))
    .addStringOption(o => o.setName('type').setDescription('Type: text or voice').setChoices(
      { name: 'Text', value: 'text' },
      { name: 'Voice', value: 'voice' }
    ).setRequired(false))
    .addChannelOption(o => o.setName('categorie').setDescription('Parent category').setRequired(false))
    .addStringOption(o => o.setName('description').setDescription('Channel description').setRequired(false))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('deletechannel')
    .setDescription('Delete one or multiple channels')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('copychannels')
    .setDescription('Copy all channels from another server')
    .addStringOption(o => o.setName('server_id').setDescription('Source server ID').setRequired(true))
    .toJSON(),
];

function isConstructionCommand(commandName) {
  return ['buildmode', 'createchannel', 'deletechannel', 'copychannels'].includes(commandName);
}

async function handleCommand(interaction, client, g, db) {
  try {
    const cmd = interaction.commandName;

    if (cmd === 'buildmode') {
      try {
        g.constructionMode = !g.constructionMode;
        await db.updateGuild(interaction.guildId, { constructionMode: g.constructionMode });
        await interaction.editReply({
          content: `Construction Mode: **${g.constructionMode ? 'ON' : 'OFF'}**`,
        });
      } catch (err) {
        console.error('Buildmode error:', err);
        await interaction.editReply({
          content: 'Error toggling construction mode.',
        }).catch(() => {});
      }
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
        content: `Channel created: <#${channel.id}>`,
      });
    }

    if (cmd === 'deletechannel') {
      const channels = interaction.guild.channels.cache
        .filter(c => c.isTextBased() || c.isVoiceBased())
        .filter(c => c.deletable)
        .slice(0, 25);

      if (channels.size === 0) {
        await interaction.editReply({ content: 'No channels to delete.' });
        return;
      }

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('delete_select_channels')
        .setPlaceholder('Select channels to delete (multiple)')
        .setMinValues(1)
        .setMaxValues(Math.min(5, channels.size));

      channels.forEach(ch => {
        selectMenu.addOptions({
          label: ch.name.substring(0, 100),
          value: ch.id,
        });
      });

      const row = new ActionRowBuilder().addComponents(selectMenu);

      await interaction.editReply({
        content: 'Select channels to delete:',
        components: [row],
      });

      setTimeout(async () => {
        try {
          await interaction.editReply({ components: [] }).catch(() => {});
        } catch (e) {}
      }, 30000);
    }

    if (cmd === 'copychannels') {
      const serverId = interaction.options.getString('server_id');
      const sourceGuild = await client.guilds.fetch(serverId).catch(() => null);

      if (!sourceGuild) {
        await interaction.editReply({ content: 'Server not found or bot not in it.' });
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
        content: `Copied ${created} channel(s) from **${sourceGuild.name}**.`,
      });
    }
  } catch (err) {
    console.error('Construction command error:', err);
    await interaction.editReply({ content: 'Command execution error.' }).catch(() => {});
  }
}

async function handleSelectMenu(interaction, client, g, db) {
  try {
    if (interaction.customId === 'delete_select_channels') {
      const channelIds = interaction.values;
      let deleted = 0;

      for (const channelId of channelIds) {
        const channel = interaction.guild.channels.cache.get(channelId);
        if (channel && channel.deletable) {
          try {
            await channel.delete('Deleted via command by ' + interaction.user.tag);
            deleted++;
          } catch (e) {}
        }
      }

      await interaction.update({
        content: `Deleted ${deleted} channel(s).`,
        components: [],
      });
      return;
    }

    if (interaction.customId.startsWith('delete_confirm_')) {
      const channelId = interaction.customId.split('_')[2];
      const channel = interaction.guild.channels.cache.get(channelId);
      if (channel && channel.deletable) {
        await channel.delete('Deletion confirmed by ' + interaction.user.tag).catch(() => {});
        await interaction.update({ content: 'Channel deleted.', embeds: [], components: [] });
      } else {
        await interaction.update({ content: 'Cannot delete channel.', embeds: [], components: [] });
      }
      return;
    }

    if (interaction.customId.startsWith('delete_cancel_')) {
      await interaction.update({ content: 'Deletion cancelled.', embeds: [], components: [] });
      return;
    }
  } catch (err) {
    console.error('Select menu error:', err);
    await interaction.update({ content: 'Error processing selection.' }).catch(() => {});
  }
}

module.exports = {
  commands,
  isConstructionCommand,
  handleCommand,
  handleSelectMenu,
};
