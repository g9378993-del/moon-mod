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
