// ========================================================================
// INDEX.JS — SECTIONS AVEC PATCHES APPLIQUÉS
// ========================================================================
// Ceci montre les 4 sections à modifier dans ton index.js existant.
// Copie-colle les sections correspondantes pour appliquer les patches.
// 
// Les marqueurs === PATCH X === indiquent où patcher.

// ========================================================================
// PATCH 1 : IMPORTS (lignes 14-17 environ)
// ========================================================================
// AVANT :
// const perms = require('./perms');
// const trade = require('./trade');

// APRÈS (à copier) :
const perms = require('./perms');
const constructionCmds = require('./construction_commands');  // ← AJOUTE CETTE LIGNE
const trade = require('./trade');
const bf = require('./brainrot-finder');

// ========================================================================
// PATCH 2 : PUSH COMMANDES (ligne 440 environ)
// ========================================================================
// AVANT :
// commands.push(...economy.commands, ...perms.commands, ...trade.commands, ...bf.commands);

// APRÈS (à copier) :
commands.push(...economy.commands, ...perms.commands, ...constructionCmds.commands, ...trade.commands, ...bf.commands);
//                                                     ^^^^^^^^^^^^^^^^^^^^^^^^^ ← AJOUTE CETTE PARTIE

// ========================================================================
// PATCH 3 : ROUTER DANS routeInteraction() (avant ligne 1195)
// ========================================================================
// Cherche dans routeInteraction() la ligne :
// if (interaction.commandName === 'ask') {

// AVANT cette ligne, ajoute :

if (constructionCmds.isConstructionCommand(interaction.commandName)) {
  if (!perms.canUseCommand(interaction.member, g, interaction.commandName)) {
    await interaction.reply({ content: "❌ Tu n'as pas la permission d'utiliser cette commande (Administrateur, Gérer le serveur, ou un rôle autorisé via `/staffrole`).", ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: ['buildmode', 'copychannels'].includes(interaction.commandName) });
  await constructionCmds.handleCommand(interaction, client, g, db);
  return;
}

// Ensuite la ligne existante :
if (interaction.commandName === 'ask') {
  // ... code existant ...
}

// ========================================================================
// PATCH 4 : HANDLERS BOUTONS DANS routeSelect() (avant catch, ~ligne 1050)
// ========================================================================
// Dans la fonction routeSelect(), cherche :
// } catch (err) {

// Juste AVANT cette ligne, ajoute :

// Confirmation de suppression de salon
if (interaction.customId.startsWith('delete_confirm_')) {
  const channelId = interaction.customId.split('_')[2];
  const channel = interaction.guild.channels.cache.get(channelId);
  if (channel && channel.deletable) {
    await channel.delete('Suppression confirmée par ' + interaction.user.tag).catch(() => {});
    await interaction.update({ content: '✅ Salon supprimé.', embeds: [], components: [] });
  } else {
    await interaction.update({ content: '❌ Impossible de supprimer le salon.', embeds: [], components: [] });
  }
  return;
}
if (interaction.customId.startsWith('delete_cancel_')) {
  await interaction.update({ content: '❌ Suppression annulée.', embeds: [], components: [] });
  return;
}

// ========================================================================
// RÉSUMÉ DES MODIFICATIONS
// ========================================================================
// PATCH 1 : 1 ligne ajoutée (import construction_commands)
// PATCH 2 : 1 mot ajouté (...constructionCmds.commands)
// PATCH 3 : ~10 lignes ajoutées (router dans routeInteraction)
// PATCH 4 : ~15 lignes ajoutées (handlers dans routeSelect)
// 
// TOTAL : ~26 lignes modifiées/ajoutées
// Aucune ligne supprimée
// 
// Risque de conflits : très faible (si personne n'a aussi touché routeInteraction/routeSelect)
// ========================================================================
