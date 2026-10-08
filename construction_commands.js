const { SlashCommandBuilder, ChannelType, ButtonBuilder, ButtonStyle, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder().setName('buildmode').setDescription('Toggle construction mode').toJSON(),
  new SlashCommandBuilder().setName('createchannel').setDescription('Create channel').addStringOption(o => o.setName('nom').setDescription('Channel name').setRequired(true)).toJSON(),
  new SlashCommandBuilder().setName('deletechannel').setDescription('Delete channels').toJSON(),
  new SlashCommandBuilder().setName('copychannels').setDescription('Copy channels from another server').addStringOption(o => o.setName('server_id').setDescription('Server ID').setRequired(true)).toJSON(),
];

function isConstructionCommand(name) {
  return ['buildmode', 'createchannel', 'deletechannel', 'copychannels'].includes(name);
}

async function handleCommand(interaction, client, g, db) {
  const cmd = interaction.commandName;
  try {
    if (cmd === 'buildmode') {
      g.constructionMode = !g.constructionMode;
      await db.updateGuild(interaction.guildId, { constructionMode: g.constructionMode });
      await interaction.editReply({ content: `Mode: ${g.constructionMode ? 'ON' : 'OFF'}` });
      return;
    }
    if (cmd === 'createchannel') {
      const nom = interaction.options.getString('nom');
      const ch = await interaction.guild.channels.create({ name: nom, type: ChannelType.GuildText });
      await interaction.editReply({ content: `[OK] <#${ch.id}> created` });
      return;
    }
    if (cmd === 'deletechannel') {
      const chans = interaction.guild.channels.cache.filter(c => c.deletable).first(5);
      if (chans.length === 0) { await interaction.editReply('[INFO] No channels'); return; }
      const opts = chans.map(c => ({ label: c.name, value: c.id }));
      const menu = new StringSelectMenuBuilder().setCustomId('delete_select_channels').setPlaceholder('Pick channels').addOptions(opts).setMaxValues(Math.min(5, opts.length));
      const row = new ActionRowBuilder().addComponents(menu);
      await interaction.editReply({ content: '[SELECT] Pick channels:', components: [row] });
      return;
    }
    if (cmd === 'copychannels') {
      const id = interaction.options.getString('server_id');
      const src = client.guilds.cache.get(id);
      if (!src) { await interaction.editReply('[ERROR] Server not found'); return; }
      let ct = 0;
      for (const c of src.channels.cache.values()) {
        try {
          await interaction.guild.channels.create({ name: c.name, type: c.type });
          ct++;
        } catch (e) { }
      }
      await interaction.editReply({ content: `[OK] ${ct} channels copied` });
      return;
    }
  } catch (err) {
    await interaction.editReply({ content: `[ERROR] ${err.message}` }).catch(() => { });
  }
}

async function handleSelectMenu(interaction, client, g, db) {
  const sel = interaction.values;
  if (!sel || sel.length === 0) { await interaction.update({ content: '[INFO] None selected', components: [] }); return; }
  const btn = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`delete_confirm_${sel[0]}`).setLabel('Confirm').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('delete_cancel_multi').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
  );
  const names = sel.map(id => interaction.guild.channels.cache.get(id)?.name || '?').join(', ');
  await interaction.update({ content: `[CONFIRM] Delete: ${names}?`, components: [btn] });
}

module.exports = { commands, isConstructionCommand, handleCommand, handleSelectMenu };
