const { SlashCommandBuilder, ChannelType, ButtonBuilder, ButtonStyle, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder().setName('buildmode').setDescription('Toggle construction mode').setDMPermission(false).toJSON(),
  new SlashCommandBuilder().setName('createchannel').setDescription('Create channel').addStringOption(o => o.setName('nom').setDescription('Channel name').setRequired(true)).setDMPermission(false).toJSON(),
  new SlashCommandBuilder().setName('deletechannel').setDescription('Delete channels').setDMPermission(false).toJSON(),
  new SlashCommandBuilder().setName('copychannels').setDescription('Copy channels from another server').addStringOption(o => o.setName('server_id').setDescription('Server ID').setRequired(true)).setDMPermission(false).toJSON(),
];

function isConstructionCommand(name) {
  return ['buildmode', 'createchannel', 'deletechannel', 'copychannels'].includes(name);
}

async function handleCommand(interaction, client, g, db) {
  const cmd = interaction.commandName;
  try {
    if (cmd === 'buildmode') {
      g.constructionMode = !g.constructionMode;
      await db.save(interaction.guildId);
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
      const chans = [...interaction.guild.channels.cache.filter(c => c.deletable).values()]
        .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0));
      if (chans.length === 0) { await interaction.editReply('[INFO] No channels'); return; }

      // Discord : 25 options par menu, 5 menus par message → 125 max sélectionnables
      const MAX = 125;
      const selectable = chans.slice(0, MAX);
      const rows = [];
      for (let i = 0; i < selectable.length; i += 25) {
        const chunk = selectable.slice(i, i + 25);
        const menu = new StringSelectMenuBuilder()
          .setCustomId(`delete_select_channels_${rows.length}`)
          .setPlaceholder(`Salons ${i + 1}–${i + chunk.length} sur ${chans.length}`)
          .addOptions(chunk.map(c => ({ label: c.name.slice(0, 100), value: c.id, description: c.parent?.name?.slice(0, 100) || undefined })))
          .setMaxValues(chunk.length);
        rows.push(new ActionRowBuilder().addComponents(menu));
      }
      const extra = chans.length > MAX ? `\n⚠️ Limite Discord : seuls les ${MAX} premiers sont affichés.` : '';
      await interaction.editReply({ content: `[SELECT] Choisis les salons à supprimer (${chans.length} au total) :${extra}`, components: rows });
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
  const names = sel.map(id => interaction.guild.channels.cache.get(id)?.name || '?').join(', ');
  const ids = sel.join(',');
  const btn = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`delete_confirm_${ids}`).setLabel('Confirm').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('delete_cancel_multi').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
  );
  // On garde tous les menus visibles mais on remplace le contenu par la confirmation
  await interaction.update({ content: `[CONFIRM] Supprimer : ${names} ?`, components: [btn] });
}

function isDeleteSelectMenu(customId) {
  return customId.startsWith('delete_select_channels');
}

module.exports = { commands, isConstructionCommand, handleCommand, handleSelectMenu, isDeleteSelectMenu };
