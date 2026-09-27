const { EmbedBuilder } = require('discord.js');
const db = require('./db');
const { COLORS, postToModLog, caseEmbed, hasModPerms } = require('./moderation');

const INVITE_RE = /(discord\.gg|discord(?:app)?\.com\/invite)\/[a-z0-9-]+/i;
const ANY_URL_RE = /https?:\/\/\S+/i;

// ------------------------------------------------------------------
// MODE MODÉRATEUR PAR SALON ("/automod salonstrict") — quand activé sur un
// salon, le bot s'y comporte comme un modérateur strict à plein temps :
// tous les liens et fichiers sont bloqués, le spam individuel est coupé
// plus vite, et un afflux soudain de messages (raid) déclenche une purge
// automatique de tout ce qui arrive pendant quelques minutes.
// ------------------------------------------------------------------
const STRICT_RAID_THRESHOLD = 8;            // messages
const STRICT_RAID_WINDOW_MS = 8000;         // en 8 secondes → raid
const STRICT_RAID_DURATION_MS = 2 * 60000;  // purge automatique pendant 2 min
const STRICT_SPAM_MAX = 3;                  // messages
const STRICT_SPAM_WINDOW_MS = 5000;         // en 5 secondes → spam
const STRICT_SPAM_TIMEOUT_MS = 5 * 60000;

const strictBurstWindows = new Map();  // channelId -> timestamps[] (tout le monde, pour le raid)
const strictSpamWindows = new Map();   // `${channelId}:${userId}` -> timestamps[]
const strictRaidMode = new Map();      // channelId -> { until }

// ------------------------------------------------------------------
// Filtre intégré multilingue de gros mots ("/automod grosmots").
// Liste volontairement centrée sur les grossièretés courantes (pas
// d'insultes à caractère raciste/homophobe/etc., pour éviter les abus de
// cette liste) — pour filtrer des injures ciblées, le staff garde
// /automod motsinterdits (liste perso, mot par mot).
// ------------------------------------------------------------------
const PROFANITY_WORDS = [
  // Français
  'putain', 'pute', 'salope', 'connard', 'connasse', 'encule', 'enculé', 'enculer',
  'batard', 'bâtard', 'merde', 'niquer', 'nique', 'foutre', 'branler', 'branleur',
  'couille', 'couillon', 'chiotte', 'pd', 'salaud',
  // Anglais
  'fuck', 'fucking', 'motherfucker', 'shit', 'bullshit', 'bitch', 'asshole',
  'bastard', 'dick', 'cunt', 'whore', 'slut', 'douchebag', 'wanker', 'twat',
  // Espagnol
  'mierda', 'puta', 'puto', 'cabron', 'cabrón', 'joder', 'gilipollas', 'pendejo',
  'coño', 'chinga', 'chingar', 'verga',
  // Allemand
  'scheisse', 'scheiße', 'arschloch', 'hurensohn', 'fotze', 'wichser',
  // Italien
  'cazzo', 'stronzo', 'puttana', 'merda', 'vaffanculo', 'coglione',
  // Portugais
  'porra', 'caralho', 'merda', 'puta', 'foda-se', 'cacete', 'desgraça',
];

// Substitutions leetspeak/contournement courantes, appliquées avant de tester
// le message contre PROFANITY_WORDS (ex: "p*t@in", "f4ck", "sh1t").
const LEET_MAP = { '@': 'a', '4': 'a', '3': 'e', '1': 'i', '!': 'i', '0': 'o', '$': 's', '5': 's', '7': 't', '+': 't' };
function normalizeForProfanity(text) {
  let s = (text || '').toLowerCase();
  s = s.replace(/[@43!105\$\+]/g, (ch) => LEET_MAP[ch] || ch);
  // Recolle les lettres séparées par UN caractère de camouflage isolé
  // (ex: "p*tain", "f.u.c.k", "n_i_q_u_e_r") sans casser les vrais espaces.
  for (let i = 0; i < 2; i++) s = s.replace(/([a-zà-ÿ])[^a-zà-ÿ\s]([a-zà-ÿ])/g, '$1$2');
  s = s.replace(/(.)\1{2,}/g, '$1$1'); // "puuutain" → "puutain"
  return s;
}
const PROFANITY_RE = new RegExp(`\\b(${PROFANITY_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\w{0,3}\\b`, 'i');

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

// Renvoie true si le message a été traité (supprimé) parce que ce salon est
// en mode modération renforcée. Le staff n'est jamais bloqué par ce mode
// (sinon impossible de calmer un salon en pleine crise).
async function checkStrictChannel(message, g) {
  if (hasModPerms(message.member, g)) return false;
  const channelId = message.channelId;

  // Mode raid déjà actif sur ce salon : on supprime tout jusqu'à expiration.
  const raid = strictRaidMode.get(channelId);
  if (raid && Date.now() < raid.until) { await deleteSafely(message); return true; }

  // Anti-transfert (toute pièce jointe)
  if (message.attachments.size > 0) {
    await deleteSafely(message);
    const c = db.addCase(g, { type: 'automod-delete', userId: message.author.id, moderatorId: null, reason: 'Transfert de fichier bloqué (salon en mode modération renforcée)' });
    await db.save(message.guild.id);
    await postToModLog(message.client, g, caseEmbed(c, message.guild.name));
    return true;
  }

  // Anti-lien (tout lien, pas seulement les invitations Discord)
  if (ANY_URL_RE.test(message.content || '')) {
    await deleteSafely(message);
    const c = db.addCase(g, { type: 'automod-delete', userId: message.author.id, moderatorId: null, reason: 'Lien bloqué (salon en mode modération renforcée)' });
    await db.save(message.guild.id);
    await postToModLog(message.client, g, caseEmbed(c, message.guild.name));
    return true;
  }

  // Anti-spam renforcé (par personne, seuil plus bas que l'automod global)
  const userKey = `${channelId}:${message.author.id}`;
  const userCount = pushAndCount(strictSpamWindows, userKey, STRICT_SPAM_WINDOW_MS);
  if (userCount > STRICT_SPAM_MAX) {
    strictSpamWindows.set(userKey, []);
    await deleteSafely(message);
    const ok = await timeoutSafely(message.member, STRICT_SPAM_TIMEOUT_MS, 'Spam dans un salon en mode modération renforcée');
    const c = db.addCase(g, { type: 'automod-timeout', userId: message.author.id, moderatorId: null, reason: `Spam dans un salon surveillé (${userCount} messages en ${STRICT_SPAM_WINDOW_MS / 1000}s)`, extra: { applied: ok } });
    await db.save(message.guild.id);
    await postToModLog(message.client, g, caseEmbed(c, message.guild.name));
    return true;
  }

  // Détection de raid : afflux soudain de messages (tous auteurs confondus)
  const burstCount = pushAndCount(strictBurstWindows, channelId, STRICT_RAID_WINDOW_MS);
  if (burstCount > STRICT_RAID_THRESHOLD) {
    strictBurstWindows.set(channelId, []);
    strictRaidMode.set(channelId, { until: Date.now() + STRICT_RAID_DURATION_MS });
    await deleteSafely(message);
    const embed = new EmbedBuilder().setColor(COLORS.raid).setTitle('🚨 Raid détecté dans un salon surveillé')
      .setDescription(`${burstCount} messages en ${STRICT_RAID_WINDOW_MS / 1000}s dans <#${channelId}>. Purge automatique activée pendant ${STRICT_RAID_DURATION_MS / 60000} minutes (tout message non-staff y sera supprimé).`);
    await postToModLog(message.client, g, embed);
    return true;
  }

  return false;
}


// été traité par l'automod (supprimé), pour que l'appelant arrête là (par
// exemple ne pas aussi lancer le chat IA sur un message qui vient d'être
// supprimé pour lien/insulte).
async function checkMessage(message) {
  if (!message.guild || message.author.bot) return false;
  const g = db.get(message.guild.id);
  const am = g.automod;
  const content = message.content || '';

  // ---- Mode modérateur strict par salon (prioritaire sur tout le reste) ----
  if ((am.strictChannels || []).includes(message.channelId)) {
    const handled = await checkStrictChannel(message, g);
    if (handled) return true;
  }

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

  // ---- Gros mots (filtre intégré multilingue) ----
  if (am.profanity?.enabled && PROFANITY_RE.test(normalizeForProfanity(content))) {
    await deleteSafely(message);
    const c = db.addCase(g, { type: 'automod-delete', userId: message.author.id, moderatorId: null, reason: 'Langage grossier détecté (filtre intégré)' });
    await db.save(message.guild.id);
    await postToModLog(message.client, g, caseEmbed(c, message.guild.name));
    return true;
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
