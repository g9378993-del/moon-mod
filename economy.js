// ================================================================
// economy.js — Système d'économie (pièces)
//  • Gain par messages dans UN salon choisi (tous les N messages → X pièces,
//    limité par jour, reset à minuit selon le fuseau configuré)
//  • Gain en vocal (toutes les X minutes/heures → Y pièces)
//  • Panel "Economy Dashboard" (boutons), leaderboard, shop, transferts
//  • Commandes staff pour tout configurer / éditer
// Les données sont stockées dans g.economy (même objet que le reste du
// serveur → même base que db.js).
// ================================================================
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  SlashCommandBuilder, ChannelType,
} = require('discord.js');
const db = require('./db');
const mod = require('./moderation');

const RED = 0xFF0000;
const COIN = '💰';
const NO_PERM = "❌ Tu n'as pas la permission d'utiliser cette commande (Administrateur, Gérer le serveur, ou un rôle autorisé via `/staffrole`).";
const MAX_AMOUNT = 1_000_000_000;

// ----------------------------------------------------------------
// DONNÉES
// ----------------------------------------------------------------
function eco(g) {
  if (!g.economy || typeof g.economy !== 'object') g.economy = {};
  const e = g.economy;
  if (!e.users) e.users = {};
  if (!Array.isArray(e.shop)) e.shop = [];
  if (!e.shopSeq) e.shopSeq = 0;
  if (!e.config) e.config = {};
  const c = e.config;
  const defaults = {
    msgChannelId: null, msgEvery: 10, msgReward: 10, msgMaxPerDay: 1,
    voiceMinutes: 0, voiceReward: 0, voiceMaxPerDay: 0, // voiceMinutes 0 = gain vocal désactivé
    timezone: 'Europe/Paris', logChannelId: null,
  };
  for (const k of Object.keys(defaults)) if (c[k] === undefined) c[k] = defaults[k];
  if (!c.panel) c.panel = { title: '', description: '', footer: '', image: '', channelId: null, messageId: null };
  return e;
}

const newUser = () => ({
  coins: 0, earned: 0, spent: 0,
  msgs: 0, msgDay: '', msgToday: 0, msgRewards: 0,
  voiceSec: 0, voiceDay: '', voiceTodaySec: 0, voiceRewards: 0, voiceCarry: 0,
});
function getUser(e, id, create = true) {
  if (e.users[id]) return e.users[id];
  if (!create) return newUser();
  e.users[id] = newUser();
  return e.users[id];
}
function dayKey(tz) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  catch { return new Date().toISOString().slice(0, 10); }
}
// Remet à zéro les compteurs "du jour" si on a changé de jour.
function roll(u, day) {
  if (u.msgDay !== day) { u.msgDay = day; u.msgToday = 0; u.msgRewards = 0; }
  if (u.voiceDay !== day) { u.voiceDay = day; u.voiceTodaySec = 0; u.voiceRewards = 0; }
}
const fmt = (n) => Number(n || 0).toLocaleString('fr-FR');
function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m} min`;
  return sec > 0 ? '< 1 min' : '0 min';
}
function rankOf(e, id) {
  const sorted = Object.entries(e.users).filter(([, u]) => u.coins > 0).sort((a, b) => b[1].coins - a[1].coins);
  const i = sorted.findIndex(([uid]) => uid === id);
  return i === -1 ? null : i + 1;
}

// Sauvegarde différée : on ne tape pas la base à CHAQUE message (trop lourd),
// on regroupe les écritures (max 1 toutes les 20 s par serveur).
const saveTimers = new Map();
function scheduleSave(guildId, delay = 20000) {
  if (saveTimers.has(guildId)) return;
  saveTimers.set(guildId, setTimeout(() => {
    saveTimers.delete(guildId);
    Promise.resolve(db.save(guildId)).catch((err) => console.error('Erreur sauvegarde économie :', err));
  }, delay));
}

// ----------------------------------------------------------------
// GAIN PAR MESSAGES
// ----------------------------------------------------------------
function onMessage(message) {
  try {
    if (!message.guild || message.author.bot) return;
    const g = db.get(message.guild.id);
    const e = eco(g); const c = e.config;
    if (!c.msgChannelId || message.channelId !== c.msgChannelId) return;

    const u = getUser(e, message.author.id);
    roll(u, dayKey(c.timezone));
    u.msgs++; u.msgToday++;

    const capped = c.msgMaxPerDay > 0 && u.msgRewards >= c.msgMaxPerDay;
    if (!capped && c.msgEvery > 0 && c.msgReward > 0 && u.msgToday % c.msgEvery === 0) {
      u.coins += c.msgReward; u.earned += c.msgReward; u.msgRewards++;
      message.react(COIN).catch(() => {}); // petit retour discret : 💰 sur le message qui a rapporté les pièces
    }
    scheduleSave(message.guild.id);
  } catch (err) { console.error('Erreur économie (message) :', err); }
}

// ----------------------------------------------------------------
// GAIN EN VOCAL — un "tick" par minute : chaque membre présent en vocal
// (hors bots et hors salon AFK) gagne 60 s de temps vocal.
// ----------------------------------------------------------------
let voiceBusy = false;
async function voiceTick(client) {
  if (voiceBusy) return;
  voiceBusy = true;
  try {
    for (const guild of client.guilds.cache.values()) {
      const g = db.get(guild.id);
      if (!g) continue;
      const e = eco(g); const c = e.config;
      const day = dayKey(c.timezone);
      let changed = false;
      for (const state of guild.voiceStates.cache.values()) {
        if (!state.channelId || state.channelId === guild.afkChannelId) continue;
        const member = state.member || await guild.members.fetch(state.id).catch(() => null);
        if (!member || member.user.bot) continue;
        const u = getUser(e, member.id);
        roll(u, day);
        u.voiceSec += 60; u.voiceTodaySec += 60; u.voiceCarry += 60;
        if (c.voiceMinutes > 0 && c.voiceReward > 0) {
          const step = c.voiceMinutes * 60;
          while (u.voiceCarry >= step) {
            u.voiceCarry -= step;
            if (c.voiceMaxPerDay === 0 || u.voiceRewards < c.voiceMaxPerDay) {
              u.coins += c.voiceReward; u.earned += c.voiceReward; u.voiceRewards++;
            }
          }
        } else u.voiceCarry = 0;
        changed = true;
      }
      if (changed) scheduleSave(guild.id, 5000);
    }
  } catch (err) { console.error('Erreur économie (vocal) :', err); }
  finally { voiceBusy = false; }
}
function startVoiceTracking(client) {
  setInterval(() => voiceTick(client), 60 * 1000);
}

// ----------------------------------------------------------------
// PANEL (embed + boutons)
// ----------------------------------------------------------------
function buildPanel(guild, g) {
  const e = eco(g); const p = e.config.panel;
  const total = Object.values(e.users).reduce((s, u) => s + (u.coins || 0), 0);
  const desc = (p.description || `Welcome to the ${guild.name} Economy System!\nUse the buttons below to navigate through different features.`).replace(/\\n/g, '\n');
  const embed = new EmbedBuilder().setColor(RED)
    .setTitle(p.title || `${COIN} Economy Dashboard`)
    .setDescription(`${desc}\n\n**📊 Current Stats:**\n\n• Total Members: ${guild.memberCount}\n• Coins in circulation: ${fmt(total)}`)
    .setFooter({ text: p.footer || guild.name });
  const thumb = p.image || guild.iconURL();
  if (thumb) embed.setThumbnail(thumb);

  const btn = (id, label, emoji, style = ButtonStyle.Danger) => new ButtonBuilder().setCustomId(`eco:${id}`).setLabel(label).setEmoji(emoji).setStyle(style);
  const components = [
    new ActionRowBuilder().addComponents(btn('coins', 'Coins', '💰'), btn('msgs', 'Messages', '📝'), btn('voice', 'Voice Time', '🎙️'), btn('lb', 'Leaderboard', '🏆')),
    new ActionRowBuilder().addComponents(btn('shop', 'Shop', '🛒'), btn('transfer', 'Transfer', '💸'), btn('how', 'How to Earn', '📖')),
    new ActionRowBuilder().addComponents(btn('add', 'Add Coins', '➕', ButtonStyle.Success), btn('remove', 'Remove Coins', '➖')),
  ];
  return { embeds: [embed], components };
}
async function refreshPanel(guild, g) {
  const p = eco(g).config.panel;
  if (!p.channelId || !p.messageId) return false;
  const ch = guild.channels.cache.get(p.channelId) || await guild.channels.fetch(p.channelId).catch(() => null);
  const msg = ch ? await ch.messages.fetch(p.messageId).catch(() => null) : null;
  if (!msg) return false;
  await msg.edit(buildPanel(guild, g)).catch(() => {});
  return true;
}

const emb = () => new EmbedBuilder().setColor(RED);
function howToEarnEmbed(e) {
  const c = e.config;
  const lines = [];
  if (c.msgChannelId) {
    lines.push(`📝 **Messages** — écris **${c.msgEvery}** messages dans <#${c.msgChannelId}> pour gagner **${c.msgReward}** ${COIN}${c.msgMaxPerDay > 0 ? ` (max **${c.msgMaxPerDay}** récompense(s) par jour, reset à minuit)` : ' (sans limite par jour)'}.`);
  } else lines.push('📝 **Messages** — pas encore configuré.');
  if (c.voiceMinutes > 0 && c.voiceReward > 0) {
    const t = c.voiceMinutes % 60 === 0 ? `${c.voiceMinutes / 60}h` : `${c.voiceMinutes} min`;
    lines.push(`🎙️ **Vocal** — reste **${t}** en vocal pour gagner **${c.voiceReward}** ${COIN}${c.voiceMaxPerDay > 0 ? ` (max **${c.voiceMaxPerDay}** récompense(s) par jour)` : ' (sans limite par jour)'}.`);
  } else lines.push('🎙️ **Vocal** — pas encore configuré.');
  lines.push('🛒 Dépense tes pièces dans le **Shop**, ou envoie-en à un ami avec **Transfer**.');
  return emb().setTitle('📖 How to Earn').setDescription(lines.join('\n\n'));
}
function shopView(e, guild) {
  const items = e.shop;
  const lines = items.map((i) => {
    const stock = i.stock === null || i.stock === undefined ? '' : (i.stock <= 0 ? ' · ❌ épuisé' : ` · stock : ${i.stock}`);
    const role = i.roleId ? ` · rôle <@&${i.roleId}>` : '';
    return `**${i.name}** — ${fmt(i.price)} ${COIN}${stock}${role}${i.description ? `\n> ${i.description}` : ''}`;
  });
  const embed = emb().setTitle('🛒 Shop').setDescription(lines.join('\n\n').slice(0, 4000) || 'Le shop est vide pour le moment.');
  const buyable = items.filter((i) => i.stock === null || i.stock === undefined || i.stock > 0).slice(0, 25);
  const components = buyable.length ? [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('eco:buy').setPlaceholder('Choisir un article à acheter...')
      .addOptions(buyable.map((i) => ({ label: i.name.slice(0, 100), description: `${fmt(i.price)} pièces`.slice(0, 100), value: i.id }))),
  )] : [];
  return { embeds: [embed], components };
}

async function logEco(guild, e, embed) {
  const id = e.config.logChannelId;
  if (!id) return;
  const ch = guild.channels.cache.get(id);
  if (ch) ch.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
}

// ----------------------------------------------------------------
// BOUTONS / MENUS / MODALS  (customId qui commence par "eco:")
// ----------------------------------------------------------------
const pickerRow = (action) => new ActionRowBuilder().addComponents(
  new UserSelectMenuBuilder().setCustomId(`eco:pick:${action}`).setPlaceholder('Choisir un membre...').setMinValues(1).setMaxValues(1),
);

async function handleComponent(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  const g = db.get(guild.id);
  const e = eco(g); const c = e.config;
  const id = interaction.customId;
  const staff = mod.hasModPerms(interaction.member, g);
  const eph = (payload) => interaction.reply({ ephemeral: true, allowedMentions: { parse: [] }, ...(typeof payload === 'string' ? { content: payload } : payload) });

  // ---------- Boutons du panel ----------
  if (interaction.isButton()) {
    const act = id.slice(4);
    const day = dayKey(c.timezone);
    const u = getUser(e, interaction.user.id, false);
    roll(u, day);

    if (act === 'coins') {
      const rank = rankOf(e, interaction.user.id);
      await eph({ embeds: [emb().setTitle(`${COIN} Ton solde`).setDescription(`**${fmt(u.coins)}** ${COIN}`)
        .addFields(
          { name: 'Total gagné', value: fmt(u.earned), inline: true },
          { name: 'Total dépensé', value: fmt(u.spent), inline: true },
          { name: 'Classement', value: rank ? `#${rank}` : '—', inline: true },
        )] });
      return;
    }
    if (act === 'msgs') {
      const lines = [`📝 Messages comptés (total) : **${fmt(u.msgs)}**`, `📅 Aujourd'hui : **${fmt(u.msgToday)}**`];
      if (c.msgChannelId) {
        const capped = c.msgMaxPerDay > 0 && u.msgRewards >= c.msgMaxPerDay;
        lines.push(`\nSalon : <#${c.msgChannelId}> · **${c.msgEvery}** messages = **${c.msgReward}** ${COIN}`);
        lines.push(`Récompenses aujourd'hui : **${u.msgRewards}${c.msgMaxPerDay > 0 ? `/${c.msgMaxPerDay}` : ''}**`);
        lines.push(capped ? '✅ Limite du jour atteinte — reviens demain !' : `⏭️ Prochaine récompense dans **${c.msgEvery - (u.msgToday % c.msgEvery)}** message(s).`);
      } else lines.push('\nLe gain par messages n\'est pas encore configuré.');
      await eph({ embeds: [emb().setTitle('📝 Tes messages').setDescription(lines.join('\n'))] });
      return;
    }
    if (act === 'voice') {
      const lines = [`🎙️ Temps vocal (total) : **${fmtDur(u.voiceSec)}**`, `📅 Aujourd'hui : **${fmtDur(u.voiceTodaySec)}**`];
      if (c.voiceMinutes > 0 && c.voiceReward > 0) {
        const capped = c.voiceMaxPerDay > 0 && u.voiceRewards >= c.voiceMaxPerDay;
        lines.push(`\n**${fmtDur(c.voiceMinutes * 60)}** en vocal = **${c.voiceReward}** ${COIN}`);
        lines.push(`Récompenses aujourd'hui : **${u.voiceRewards}${c.voiceMaxPerDay > 0 ? `/${c.voiceMaxPerDay}` : ''}**`);
        lines.push(capped ? '✅ Limite du jour atteinte — reviens demain !' : `⏭️ Prochaine récompense dans **${fmtDur(c.voiceMinutes * 60 - u.voiceCarry)}**.`);
      } else lines.push('\nLe gain en vocal n\'est pas encore configuré.');
      await eph({ embeds: [emb().setTitle('🎙️ Ton temps vocal').setDescription(lines.join('\n'))] });
      return;
    }
    if (act === 'lb') {
      const top = Object.entries(e.users).filter(([, x]) => x.coins > 0).sort((a, b) => b[1].coins - a[1].coins).slice(0, 10);
      const medals = ['🥇', '🥈', '🥉'];
      const lines = top.map(([uid, x], i) => `${medals[i] || `**${i + 1}.**`} <@${uid}> — **${fmt(x.coins)}** ${COIN}`);
      const rank = rankOf(e, interaction.user.id);
      await eph({ embeds: [emb().setTitle('🏆 Leaderboard').setDescription(lines.join('\n') || 'Personne n\'a encore de pièces.')
        .setFooter({ text: rank ? `Ta position : #${rank}` : 'Tu n\'es pas encore classé' })] });
      return;
    }
    if (act === 'shop') { await eph(shopView(e, guild)); return; }
    if (act === 'how') { await eph({ embeds: [howToEarnEmbed(e)] }); return; }
    if (act === 'transfer') { await eph({ content: '💸 À qui veux-tu envoyer des pièces ?', components: [pickerRow('transfer')] }); return; }
    if (act === 'add' || act === 'remove') {
      if (!staff) { await eph(NO_PERM); return; }
      await eph({ content: act === 'add' ? '➕ À quel membre ajouter des pièces ?' : '➖ À quel membre retirer des pièces ?', components: [pickerRow(act)] });
      return;
    }
    return;
  }

  // ---------- Choix d'un membre → on demande le montant dans un modal ----------
  if (interaction.isUserSelectMenu() && id.startsWith('eco:pick:')) {
    const action = id.split(':')[2];
    if ((action === 'add' || action === 'remove') && !staff) { await eph(NO_PERM); return; }
    const targetId = interaction.values[0];
    const titles = { transfer: 'Transférer des pièces', add: 'Ajouter des pièces', remove: 'Retirer des pièces' };
    const modal = new ModalBuilder().setCustomId(`eco:amt:${action}:${targetId}`).setTitle(titles[action] || 'Montant');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('amount').setLabel('Montant (nombre entier)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(12).setPlaceholder('Ex: 100'),
    ));
    await interaction.showModal(modal);
    return;
  }

  // ---------- Modal : montant saisi ----------
  if (interaction.isModalSubmit() && id.startsWith('eco:amt:')) {
    const [, , action, targetId] = id.split(':');
    const amount = Number(interaction.fields.getTextInputValue('amount').replace(/[\s,_]/g, ''));
    if (!Number.isInteger(amount) || amount < 1 || amount > MAX_AMOUNT) { await eph('❌ Montant invalide (entier positif).'); return; }
    const targetMember = await guild.members.fetch(targetId).catch(() => null);
    if (!targetMember || targetMember.user.bot) { await eph('❌ Membre introuvable (ou c\'est un bot).'); return; }

    if (action === 'transfer') {
      if (targetId === interaction.user.id) { await eph('❌ Tu ne peux pas t\'envoyer des pièces à toi-même.'); return; }
      const from = getUser(e, interaction.user.id);
      if (from.coins < amount) { await eph(`❌ Solde insuffisant : tu as **${fmt(from.coins)}** ${COIN}.`); return; }
      const to = getUser(e, targetId);
      from.coins -= amount; to.coins += amount;
      await db.save(guild.id);
      await eph(`✅ Tu as envoyé **${fmt(amount)}** ${COIN} à <@${targetId}>. Nouveau solde : **${fmt(from.coins)}** ${COIN}.`);
      return;
    }
    if (action === 'add' || action === 'remove') {
      if (!staff) { await eph(NO_PERM); return; }
      const t = getUser(e, targetId);
      t.coins = action === 'add' ? t.coins + amount : Math.max(0, t.coins - amount);
      await db.save(guild.id);
      await logEco(guild, e, emb().setTitle(action === 'add' ? '➕ Pièces ajoutées' : '➖ Pièces retirées')
        .setDescription(`<@${interaction.user.id}> ${action === 'add' ? 'a ajouté' : 'a retiré'} **${fmt(amount)}** ${COIN} ${action === 'add' ? 'à' : 'à'} <@${targetId}> (solde : **${fmt(t.coins)}**).`));
      await eph(`✅ ${action === 'add' ? 'Ajouté' : 'Retiré'} **${fmt(amount)}** ${COIN} — <@${targetId}> a maintenant **${fmt(t.coins)}** ${COIN}.`);
      return;
    }
    return;
  }

  // ---------- Achat dans le shop ----------
  if (interaction.isStringSelectMenu() && id === 'eco:buy') {
    const item = e.shop.find((i) => i.id === interaction.values[0]);
    if (!item) { await eph('❌ Cet article n\'existe plus.'); return; }
    if (item.stock !== null && item.stock !== undefined && item.stock <= 0) { await eph('❌ Cet article est épuisé.'); return; }
    const member = interaction.member;
    if (item.roleId && member.roles.cache.has(item.roleId)) { await eph('❌ Tu as déjà ce rôle.'); return; }
    const u = getUser(e, interaction.user.id);
    if (u.coins < item.price) { await eph(`❌ Il te manque **${fmt(item.price - u.coins)}** ${COIN} (solde : ${fmt(u.coins)}).`); return; }

    // On débite AVANT tout appel réseau (évite le double achat par double-clic),
    // et on rembourse si la remise du rôle échoue.
    u.coins -= item.price; u.spent += item.price;
    if (item.stock !== null && item.stock !== undefined) item.stock--;
    if (item.roleId) {
      try { await member.roles.add(item.roleId, 'Achat shop'); }
      catch (err) {
        u.coins += item.price; u.spent -= item.price;
        if (item.stock !== null && item.stock !== undefined) item.stock++;
        await eph('❌ Je n\'ai pas pu te donner le rôle (mon rôle doit être au-dessus). Tu n\'as pas été débité.');
        return;
      }
    }
    await db.save(guild.id);
    await logEco(guild, e, emb().setTitle('🛒 Achat')
      .setDescription(`<@${interaction.user.id}> a acheté **${item.name}** pour **${fmt(item.price)}** ${COIN}${item.roleId ? ` (rôle <@&${item.roleId}> donné)` : ' — à livrer par le staff'}.`));
    await eph(`✅ Tu as acheté **${item.name}** pour **${fmt(item.price)}** ${COIN}. Nouveau solde : **${fmt(u.coins)}** ${COIN}.${item.roleId ? '' : '\nUn membre du staff va te contacter pour la livraison.'}`);
    return;
  }
}

async function autocomplete(interaction) {
  if (!interaction.guildId) return;
  const e = eco(db.get(interaction.guildId));
  const q = interaction.options.getFocused().toLowerCase();
  const choices = e.shop.filter((i) => i.name.toLowerCase().includes(q)).slice(0, 25)
    .map((i) => ({ name: `${i.name} (${i.price})`.slice(0, 100), value: i.id }));
  await interaction.respond(choices).catch(() => {});
}

// ----------------------------------------------------------------
// COMMANDES SLASH
// ----------------------------------------------------------------
const itemOpt = (o) => o.setName('item').setDescription('Article du shop').setRequired(true).setAutocomplete(true);
const commands = [
  new SlashCommandBuilder().setName('panelcoins').setDescription('(Staff) Poster le panel économie (Coins, Shop, Leaderboard...)')
    .addChannelOption((o) => o.setName('salon').setDescription('Salon où poster le panel (défaut : ici)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),

  new SlashCommandBuilder().setName('coins').setDescription('Voir ton solde de pièces')
    .addUserOption((o) => o.setName('membre').setDescription('Voir le solde de quelqu\'un d\'autre')),

  new SlashCommandBuilder().setName('ecoadmin').setDescription('(Staff) Gérer les pièces des membres')
    .addSubcommand((s) => s.setName('add').setDescription('Ajouter des pièces')
      .addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true))
      .addIntegerOption((o) => o.setName('montant').setDescription('Nombre de pièces').setRequired(true).setMinValue(1).setMaxValue(MAX_AMOUNT)))
    .addSubcommand((s) => s.setName('remove').setDescription('Retirer des pièces')
      .addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true))
      .addIntegerOption((o) => o.setName('montant').setDescription('Nombre de pièces').setRequired(true).setMinValue(1).setMaxValue(MAX_AMOUNT)))
    .addSubcommand((s) => s.setName('set').setDescription('Fixer le solde exact')
      .addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true))
      .addIntegerOption((o) => o.setName('montant').setDescription('Nouveau solde').setRequired(true).setMinValue(0).setMaxValue(MAX_AMOUNT)))
    .addSubcommand((s) => s.setName('reset').setDescription('Remettre un membre à zéro (pièces + stats)')
      .addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true))),

  new SlashCommandBuilder().setName('ecoconfig').setDescription('(Staff) Configurer l\'économie')
    .addSubcommand((s) => s.setName('messages').setDescription('Gain par messages : salon + règle')
      .addChannelOption((o) => o.setName('salon').setDescription('Salon où les messages comptent').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
      .addIntegerOption((o) => o.setName('nombre').setDescription('Tous les combien de messages (ex: 10)').setRequired(true).setMinValue(1).setMaxValue(10000))
      .addIntegerOption((o) => o.setName('pieces').setDescription('Pièces gagnées à chaque palier').setRequired(true).setMinValue(1).setMaxValue(MAX_AMOUNT))
      .addIntegerOption((o) => o.setName('par_jour').setDescription('Récompenses max par jour (défaut 1, 0 = illimité)').setMinValue(0).setMaxValue(1000)))
    .addSubcommand((s) => s.setName('vocal').setDescription('Gain en vocal : durée + récompense')
      .addIntegerOption((o) => o.setName('pieces').setDescription('Pièces gagnées à chaque palier').setRequired(true).setMinValue(1).setMaxValue(MAX_AMOUNT))
      .addIntegerOption((o) => o.setName('heures').setDescription('Heures par palier').setMinValue(0).setMaxValue(240))
      .addIntegerOption((o) => o.setName('minutes').setDescription('Minutes par palier').setMinValue(0).setMaxValue(59))
      .addIntegerOption((o) => o.setName('par_jour').setDescription('Récompenses max par jour (défaut 0 = illimité)').setMinValue(0).setMaxValue(1000)))
    .addSubcommand((s) => s.setName('off').setDescription('Désactiver un gain')
      .addStringOption((o) => o.setName('quoi').setDescription('Quoi désactiver').setRequired(true).addChoices({ name: 'Messages', value: 'messages' }, { name: 'Vocal', value: 'vocal' })))
    .addSubcommand((s) => s.setName('panel').setDescription('Modifier les textes du panel (- = remettre par défaut)')
      .addStringOption((o) => o.setName('titre').setDescription('Titre du panel'))
      .addStringOption((o) => o.setName('description').setDescription('Texte du panel (\\n pour aller à la ligne)'))
      .addStringOption((o) => o.setName('pied').setDescription('Texte du bas (footer)'))
      .addStringOption((o) => o.setName('image').setDescription('URL de l\'image/logo (en haut à droite)')))
    .addSubcommand((s) => s.setName('fuseau').setDescription('Fuseau horaire du reset quotidien (ex: Europe/Paris)')
      .addStringOption((o) => o.setName('nom').setDescription('Ex: Europe/Paris, America/New_York').setRequired(true)))
    .addSubcommand((s) => s.setName('logs').setDescription('Salon des logs (achats, ajouts/retraits) — vide = désactiver')
      .addChannelOption((o) => o.setName('salon').setDescription('Salon des logs').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand((s) => s.setName('voir').setDescription('Voir la configuration actuelle')),

  new SlashCommandBuilder().setName('shop').setDescription('Le shop (voir = tout le monde, le reste = staff)')
    .addSubcommand((s) => s.setName('list').setDescription('Voir les articles du shop'))
    .addSubcommand((s) => s.setName('add').setDescription('(Staff) Ajouter un article')
      .addStringOption((o) => o.setName('nom').setDescription('Nom de l\'article').setRequired(true).setMaxLength(80))
      .addIntegerOption((o) => o.setName('prix').setDescription('Prix en pièces').setRequired(true).setMinValue(0).setMaxValue(MAX_AMOUNT))
      .addStringOption((o) => o.setName('description').setDescription('Description').setMaxLength(200))
      .addRoleOption((o) => o.setName('role').setDescription('Rôle donné automatiquement à l\'achat'))
      .addIntegerOption((o) => o.setName('stock').setDescription('Quantité disponible (vide = illimité)').setMinValue(1).setMaxValue(1000000)))
    .addSubcommand((s) => s.setName('edit').setDescription('(Staff) Modifier un article')
      .addStringOption(itemOpt)
      .addStringOption((o) => o.setName('nom').setDescription('Nouveau nom').setMaxLength(80))
      .addIntegerOption((o) => o.setName('prix').setDescription('Nouveau prix').setMinValue(0).setMaxValue(MAX_AMOUNT))
      .addStringOption((o) => o.setName('description').setDescription('Nouvelle description (- = effacer)').setMaxLength(200))
      .addRoleOption((o) => o.setName('role').setDescription('Nouveau rôle donné à l\'achat'))
      .addBooleanOption((o) => o.setName('retirer_role').setDescription('Ne plus donner de rôle'))
      .addIntegerOption((o) => o.setName('stock').setDescription('Nouveau stock (0 = épuisé)').setMinValue(0).setMaxValue(1000000))
      .addBooleanOption((o) => o.setName('illimite').setDescription('Stock illimité')))
    .addSubcommand((s) => s.setName('remove').setDescription('(Staff) Supprimer un article')
      .addStringOption(itemOpt)),
].map((c) => c.setDMPermission(false).toJSON());

const COMMAND_NAMES = new Set(['panelcoins', 'coins', 'ecoadmin', 'ecoconfig', 'shop']);
const isEconomyCommand = (name) => COMMAND_NAMES.has(name);

async function handleCommand(interaction) {
  const guild = interaction.guild;
  const g = db.get(guild.id);
  const e = eco(g); const c = e.config;
  const name = interaction.commandName;
  const sub = interaction.options.getSubcommand(false);
  const staff = mod.hasModPerms(interaction.member, g);
  const isPublic = name === 'coins' || (name === 'shop' && sub === 'list');
  if (!isPublic && !staff) { await interaction.reply({ content: NO_PERM, ephemeral: true }); return; }
  await interaction.deferReply({ ephemeral: true });
  const reply = (content, extra = {}) => interaction.editReply({ content, allowedMentions: { parse: [] }, ...extra });

  // ---------- /panelcoins ----------
  if (name === 'panelcoins') {
    const channel = interaction.options.getChannel('salon') || interaction.channel;
    const p = c.panel;
    try {
      const msg = await channel.send(buildPanel(guild, g));
      if (p.channelId && p.messageId) {
        const oldCh = guild.channels.cache.get(p.channelId);
        if (oldCh) oldCh.messages.delete(p.messageId).catch(() => {});
      }
      p.channelId = channel.id; p.messageId = msg.id;
      await db.save(guild.id);
      await reply(`✅ Panel posté dans ${channel}.`);
    } catch (err) { await reply(`❌ Impossible de poster dans ${channel} (${err.message}). Vérifie mes permissions.`); }
    return;
  }

  // ---------- /coins ----------
  if (name === 'coins') {
    const target = interaction.options.getUser('membre') || interaction.user;
    const u = getUser(e, target.id, false);
    const rank = rankOf(e, target.id);
    await reply('', { embeds: [emb().setTitle(`${COIN} Solde de ${target.username}`).setDescription(`**${fmt(u.coins)}** ${COIN}`)
      .addFields({ name: 'Total gagné', value: fmt(u.earned), inline: true }, { name: 'Total dépensé', value: fmt(u.spent), inline: true }, { name: 'Classement', value: rank ? `#${rank}` : '—', inline: true })] });
    return;
  }

  // ---------- /ecoadmin ----------
  if (name === 'ecoadmin') {
    const target = interaction.options.getUser('membre');
    if (target.bot) { await reply('❌ Les bots n\'ont pas de pièces.'); return; }
    const amount = interaction.options.getInteger('montant');
    const t = getUser(e, target.id);
    let action;
    if (sub === 'add') { t.coins += amount; action = `a ajouté **${fmt(amount)}** ${COIN} à`; }
    else if (sub === 'remove') { t.coins = Math.max(0, t.coins - amount); action = `a retiré **${fmt(amount)}** ${COIN} à`; }
    else if (sub === 'set') { t.coins = amount; action = `a fixé le solde à **${fmt(amount)}** ${COIN} pour`; }
    else { e.users[target.id] = newUser(); action = 'a remis à zéro'; }
    await db.save(guild.id);
    await logEco(guild, e, emb().setTitle('🛠️ Pièces modifiées').setDescription(`<@${interaction.user.id}> ${action} <@${target.id}> (solde : **${fmt(e.users[target.id].coins)}**).`));
    await reply(`✅ <@${target.id}> a maintenant **${fmt(e.users[target.id].coins)}** ${COIN}.`);
    return;
  }

  // ---------- /ecoconfig ----------
  if (name === 'ecoconfig') {
    if (sub === 'messages') {
      const ch = interaction.options.getChannel('salon');
      c.msgChannelId = ch.id;
      c.msgEvery = interaction.options.getInteger('nombre');
      c.msgReward = interaction.options.getInteger('pieces');
      const pj = interaction.options.getInteger('par_jour');
      c.msgMaxPerDay = pj === null ? 1 : pj;
      await db.save(guild.id);
      await reply(`✅ Messages : dans ${ch}, tous les **${c.msgEvery}** messages = **${c.msgReward}** ${COIN} (${c.msgMaxPerDay > 0 ? `max ${c.msgMaxPerDay} fois par jour` : 'sans limite par jour'}).`);
      return;
    }
    if (sub === 'vocal') {
      const total = (interaction.options.getInteger('heures') || 0) * 60 + (interaction.options.getInteger('minutes') || 0);
      if (total < 1) { await reply('❌ Indique au moins `heures` ou `minutes`.'); return; }
      c.voiceMinutes = total;
      c.voiceReward = interaction.options.getInteger('pieces');
      const pj = interaction.options.getInteger('par_jour');
      c.voiceMaxPerDay = pj === null ? 0 : pj;
      await db.save(guild.id);
      await reply(`✅ Vocal : toutes les **${fmtDur(total * 60)}** en vocal = **${c.voiceReward}** ${COIN} (${c.voiceMaxPerDay > 0 ? `max ${c.voiceMaxPerDay} fois par jour` : 'sans limite par jour'}).`);
      return;
    }
    if (sub === 'off') {
      if (interaction.options.getString('quoi') === 'messages') { c.msgChannelId = null; await db.save(guild.id); await reply('✅ Gain par messages désactivé.'); }
      else { c.voiceMinutes = 0; c.voiceReward = 0; await db.save(guild.id); await reply('✅ Gain en vocal désactivé (le temps vocal continue d\'être compté).'); }
      return;
    }
    if (sub === 'panel') {
      const p = c.panel;
      const set = (opt, key) => { const v = interaction.options.getString(opt); if (v !== null) p[key] = v === '-' ? '' : v; return v !== null; };
      const changed = [set('titre', 'title'), set('description', 'description'), set('pied', 'footer'), set('image', 'image')].some(Boolean);
      if (!changed) { await reply('ℹ️ Rien à modifier : donne au moins une option (`titre`, `description`, `pied`, `image`).'); return; }
      await db.save(guild.id);
      const ok = await refreshPanel(guild, g);
      await reply(ok ? '✅ Panel mis à jour.' : '✅ Enregistré. Le panel n\'existe pas encore (ou a été supprimé) : lance `/panelcoins`.');
      return;
    }
    if (sub === 'fuseau') {
      const tz = interaction.options.getString('nom').trim();
      try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); } catch { await reply('❌ Fuseau invalide. Exemples : `Europe/Paris`, `America/New_York`, `UTC`.'); return; }
      c.timezone = tz; await db.save(guild.id);
      await reply(`✅ Le reset quotidien se fait maintenant à minuit **${tz}**.`);
      return;
    }
    if (sub === 'logs') {
      const ch = interaction.options.getChannel('salon');
      c.logChannelId = ch ? ch.id : null; await db.save(guild.id);
      await reply(ch ? `✅ Logs économie dans ${ch}.` : '✅ Logs économie désactivés.');
      return;
    }
    if (sub === 'voir') {
      const p = c.panel;
      const embed = emb().setTitle('⚙️ Configuration économie').addFields(
        { name: '📝 Messages', value: c.msgChannelId ? `<#${c.msgChannelId}> · ${c.msgEvery} msg = ${c.msgReward} ${COIN} · ${c.msgMaxPerDay > 0 ? `${c.msgMaxPerDay}/jour` : 'illimité'}` : 'Désactivé' },
        { name: '🎙️ Vocal', value: c.voiceMinutes > 0 && c.voiceReward > 0 ? `${fmtDur(c.voiceMinutes * 60)} = ${c.voiceReward} ${COIN} · ${c.voiceMaxPerDay > 0 ? `${c.voiceMaxPerDay}/jour` : 'illimité'}` : 'Désactivé' },
        { name: '🕛 Reset quotidien', value: c.timezone, inline: true },
        { name: '🧾 Logs', value: c.logChannelId ? `<#${c.logChannelId}>` : 'Aucun', inline: true },
        { name: '🖼️ Panel', value: p.channelId ? `<#${p.channelId}>` : 'Pas encore posté (`/panelcoins`)', inline: true },
        { name: '🛒 Shop', value: `${e.shop.length} article(s)`, inline: true },
        { name: '👥 Membres avec des pièces', value: String(Object.values(e.users).filter((x) => x.coins > 0).length), inline: true },
      );
      await reply('', { embeds: [embed] });
      return;
    }
  }

  // ---------- /shop ----------
  if (name === 'shop') {
    if (sub === 'list') { await reply('', shopView(e, guild)); return; }

    const checkRole = (role) => (role && (role.managed || guild.members.me.roles.highest.comparePositionTo(role) <= 0)
      ? '\n⚠️ Je ne pourrai pas donner ce rôle (mon rôle doit être **au-dessus** dans la liste des rôles, et ce ne doit pas être un rôle de bot).' : '');

    if (sub === 'add') {
      if (e.shop.length >= 25) { await reply('❌ Maximum 25 articles (limite Discord des menus).'); return; }
      const role = interaction.options.getRole('role');
      const stock = interaction.options.getInteger('stock');
      const item = {
        id: String(++e.shopSeq),
        name: interaction.options.getString('nom'),
        price: interaction.options.getInteger('prix'),
        description: interaction.options.getString('description') || '',
        roleId: role ? role.id : null,
        stock: stock === null ? null : stock,
      };
      e.shop.push(item);
      await db.save(guild.id);
      await reply(`✅ Article ajouté : **${item.name}** — ${fmt(item.price)} ${COIN}.${checkRole(role)}`);
      return;
    }
    const item = e.shop.find((i) => i.id === interaction.options.getString('item'));
    if (!item) { await reply('❌ Article introuvable (choisis-le dans la liste proposée).'); return; }
    if (sub === 'remove') {
      e.shop = e.shop.filter((i) => i !== item);
      await db.save(guild.id);
      await reply(`✅ Article supprimé : **${item.name}**.`);
      return;
    }
    if (sub === 'edit') {
      const o = interaction.options;
      if (o.getString('nom') !== null) item.name = o.getString('nom');
      if (o.getInteger('prix') !== null) item.price = o.getInteger('prix');
      if (o.getString('description') !== null) item.description = o.getString('description') === '-' ? '' : o.getString('description');
      const role = o.getRole('role');
      if (role) item.roleId = role.id;
      if (o.getBoolean('retirer_role')) item.roleId = null;
      if (o.getInteger('stock') !== null) item.stock = o.getInteger('stock');
      if (o.getBoolean('illimite')) item.stock = null;
      await db.save(guild.id);
      await reply(`✅ Article modifié : **${item.name}** — ${fmt(item.price)} ${COIN}.${checkRole(role)}`);
      return;
    }
  }
}

module.exports = { commands, isEconomyCommand, handleCommand, handleComponent, autocomplete, onMessage, startVoiceTracking, voiceTick, _internals: { eco, getUser, roll, dayKey } };
