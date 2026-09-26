const { EmbedBuilder } = require('discord.js');
const db = require('./db');
const { COLORS, postToModLog, caseEmbed } = require('./moderation');

const INVITE_RE = /(discord\.gg|discord(?:app)?\.com\/invite)\/[a-z0-9-]+/i;

// Fenêtres glissantes en mémoire (pas besoin de les garder après un
// redémarrage). Clé : `${guildId}:${userId}` pour spam/mentions, `${guildId}`
// pour les arrivées (anti-raid).
const messageWindows = new Map();
const joinWindows = new Map();
const RAID_MODE = new Map(); // guildId -> { until }

function pushAndCount(map, key, windowMs) {
  const now = Date.now();
  const arr = (map.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  map.set(key, arr);
  return arr.length;
}

async function deleteSafely(message) {
  try { await message.delete(); } catch (e) { /* déjà supprimé / permissions */ }
}

async function timeoutSafely(member, ms, reason) {
  try { await member.timeout(ms, reason); return true; } catch (e) { console.error('Timeout automod impossible :', e.message); return false; }
}

// Appelé sur CHAQUE message d'un salon texte. Renvoie true si le message a
// été traité par l'automod (supprimé), pour que l'appelant arrête là (par
// exemple ne pas aussi lancer le chat IA sur un message qui vient d'être
// supprimé pour lien/insulte).
async function checkMessage(message) {
  if (!message.guild || message.author.bot) return false;
  const g = db.get(message.guild.id);
  const am = g.automod;
  const content = message.content || '';

  // ---- Anti-lien (invitations Discord) ----
  if (am.antiLink.enabled && INVITE_RE.test(content)) {
    await deleteSafely(message);
    const c = db.addCase(g, { type: 'automod-delete', userId: message.author.id, moderatorId: null, reason: "Lien d'invitation Discord non autorisé" });
    await db.save(message.guild.id);
    await postToModLog(message.client, g, caseEmbed(c, message.guild.name));
    return true;
  }

  // ---- Mots interdits ----
  if (am.badWords.enabled && am.badWords.words.length) {
    const lower = content.toLowerCase();
    const hit = am.badWords.words.find((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lower));
    if (hit) {
      await deleteSafely(message);
      const c = db.addCase(g, { type: 'automod-delete', userId: message.author.id, moderatorId: null, reason: 'Mot interdit détecté' });
      await db.save(message.guild.id);
      await postToModLog(message.client, g, caseEmbed(c, message.guild.name));
      return true;
    }
  }

  // ---- Anti-mention (spam de mentions) ----
  if (am.antiMention.enabled) {
    const total = message.mentions.users.size + message.mentions.roles.size;
    if (total > am.antiMention.maxMentions) {
      await deleteSafely(message);
      const ms = am.antiMention.timeoutMinutes * 60000;
      const ok = await timeoutSafely(message.member, ms, 'Spam de mentions (automod)');
      const c = db.addCase(g, { type: 'automod-timeout', userId: message.author.id, moderatorId: null, reason: `Spam de mentions (${total} mentions)`, extra: { minutes: am.antiMention.timeoutMinutes, applied: ok } });
      await db.save(message.guild.id);
      await postToModLog(message.client, g, caseEmbed(c, message.guild.name));
      return true;
    }
  }

  // ---- Anti-spam (trop de messages trop vite) ----
  if (am.antiSpam.enabled) {
    const key = `${message.guild.id}:${message.author.id}`;
    const count = pushAndCount(messageWindows, key, am.antiSpam.perSeconds * 1000);
    if (count > am.antiSpam.maxMessages) {
      messageWindows.set(key, []); // évite de re-déclencher à chaque message suivant
      await deleteSafely(message);
      const ms = am.antiSpam.timeoutMinutes * 60000;
      const ok = await timeoutSafely(message.member, ms, 'Spam de messages (automod)');
      const c = db.addCase(g, { type: 'automod-timeout', userId: message.author.id, moderatorId: null, reason: `Spam de messages (${count} messages en ${am.antiSpam.perSeconds}s)`, extra: { minutes: am.antiSpam.timeoutMinutes, applied: ok } });
      await db.save(message.guild.id);
      await postToModLog(message.client, g, caseEmbed(c, message.guild.name));
      return true;
    }
  }

  return false;
}

// Appelé sur CHAQUE arrivée de membre. Détecte un afflux anormal (raid) et
// agit selon la config (timeout / kick des comptes trop récents / alerte
// seule).
async function checkJoin(member) {
  const g = db.get(member.guild.id);
  const ar = g.automod.antiRaid;
  if (!ar.enabled) return;

  const count = pushAndCount(joinWindows, member.guild.id, ar.windowSeconds * 1000);
  const accountAgeDays = (Date.now() - member.user.createdTimestamp) / 86400000;
  const suspicious = accountAgeDays < ar.minAccountAgeDays;

  if (count > ar.joinThreshold) {
    const already = RAID_MODE.get(member.guild.id);
    if (!already || Date.now() > already.until) {
      RAID_MODE.set(member.guild.id, { until: Date.now() + 10 * 60000 });
      const embed = new EmbedBuilder().setColor(COLORS.raid).setTitle('🚨 Afflux anormal de membres détecté (raid probable)')
        .setDescription(`${count} arrivées en ${ar.windowSeconds}s. Mode vigilance activé 10 minutes : les comptes récents (< ${ar.minAccountAgeDays}j) sont ${ar.action === 'kick' ? 'expulsés' : ar.action === 'timeout' ? 'mis en sourdine' : 'juste signalés'} automatiquement.`);
      await postToModLog(member.client, g, embed);
    }
  }

  const inRaidMode = RAID_MODE.get(member.guild.id);
  if (inRaidMode && Date.now() < inRaidMode.until && suspicious && ar.action !== 'alert_only') {
    try {
      if (ar.action === 'kick') {
        await member.kick('Anti-raid : compte trop récent pendant une vague de nouveaux arrivants');
      } else {
        await member.timeout(30 * 60000, 'Anti-raid : compte trop récent pendant une vague de nouveaux arrivants');
      }
      const c = db.addCase(g, { type: 'raid', userId: member.id, moderatorId: null, reason: `Compte créé il y a ${accountAgeDays.toFixed(1)}j, arrivé pendant une vague suspecte`, extra: { action: ar.action } });
      await db.save(member.guild.id);
      await postToModLog(member.client, g, caseEmbed(c, member.guild.name));
    } catch (e) { console.error('Action anti-raid impossible :', e.message); }
  }
}

module.exports = { checkMessage, checkJoin, INVITE_RE };
