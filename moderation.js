const { PermissionFlagsBits, EmbedBuilder } = require('discord.js');

const COLORS = { kick: 0xFF9F43, ban: 0xE74C3C, warn: 0xF1C40F, timeout: 0xE67E22, unban: 0x2ECC71, untimeout: 0x2ECC71, automod: 0x9B59B6, raid: 0xC0392B, info: 0x5865F2, ticket: 0x57F287, ticketClose: 0xED4245, source: 0x5865F2 };
const MAX_TIMEOUT_MS = 28 * 24 * 3600 * 1000; // limite imposée par Discord

// Qui peut utiliser les commandes de modération : Administrateur, Gérer le
// serveur, ou un rôle ajouté via /staffrole.
function hasModPerms(member, g) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  const roleIds = member.roles?.cache ? [...member.roles.cache.keys()] : [];
  return (g.staffRoles || []).some((r) => roleIds.includes(r));
}

// Empêche de modérer quelqu'un de plus haut placé (ou égal) que soi, et le
// bot lui-même de cibler quelqu'un au-dessus de sa propre position.
function canTarget(actorMember, targetMember, botMember) {
  if (!targetMember) return { ok: true };
  if (targetMember.id === actorMember.id) return { ok: false, reason: "Tu ne peux pas te cibler toi-même." };
  if (targetMember.permissions.has(PermissionFlagsBits.Administrator) && actorMember.id !== targetMember.guild.ownerId) {
    return { ok: false, reason: 'Cette personne est administratrice.' };
  }
  if (actorMember.roles.highest.position <= targetMember.roles.highest.position && actorMember.id !== targetMember.guild.ownerId) {
    return { ok: false, reason: 'Cette personne a un rôle égal ou supérieur au tien.' };
  }
  if (botMember && botMember.roles.highest.position <= targetMember.roles.highest.position) {
    return { ok: false, reason: "Le bot n'a pas un rôle assez haut pour agir sur cette personne (monte son rôle dans la liste des rôles)." };
  }
  return { ok: true };
}

// Parse "10m", "2h", "1d", "30" (minutes par défaut) → millisecondes.
// Renvoie null si invalide, et cap à la limite Discord (28 jours).
function parseDuration(input) {
  if (!input) return null;
  const m = String(input).trim().match(/^(\d+)\s*(s|m|h|d|w)?$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = (m[2] || 'm').toLowerCase();
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[unit];
  const ms = n * mult;
  if (ms <= 0) return null;
  return Math.min(ms, MAX_TIMEOUT_MS);
}
function fmtDuration(ms) {
  if (!ms) return 'indéfini';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  if (mins < 1440) return `${Math.round(mins / 60)} h`;
  return `${Math.round(mins / 1440)} j`;
}

function caseEmbed(c, guildName) {
  const titles = {
    kick: '👢 Kick', ban: '🔨 Ban', unban: '✅ Unban', warn: '⚠️ Avertissement', timeout: '🔇 Timeout',
    untimeout: '🔊 Fin de timeout', 'automod-delete': '🤖 Automod (message supprimé)', 'automod-timeout': '🤖 Automod (timeout auto)', raid: '🚨 Anti-raid',
  };
  return new EmbedBuilder()
    .setColor(COLORS[c.type.split('-')[0]] || COLORS.info)
    .setTitle(`${titles[c.type] || c.type} — Cas #${c.id}`)
    .addFields(
      { name: 'Utilisateur', value: `<@${c.userId}> (\`${c.userId}\`)`, inline: true },
      { name: 'Modérateur', value: c.moderatorId ? `<@${c.moderatorId}>` : 'Automod', inline: true },
      { name: 'Raison', value: c.reason || 'Aucune', inline: false },
    )
    .setFooter({ text: guildName || '' })
    .setTimestamp(c.createdAt);
}

async function postToModLog(client, g, embed) {
  if (!g.modLogChannelId) return;
  try {
    const channel = await client.channels.fetch(g.modLogChannelId);
    await channel.send({ embeds: [embed] });
  } catch (e) { console.error('Envoi au salon de logs impossible :', e.message); }
}

// Applique l'escalade automatique selon le nombre d'avertissements actifs
// (warnThresholds, configurable via /warnactions). Renvoie une action ou null.
function computeWarnEscalation(g, warnCount) {
  const applicable = (g.warnThresholds || []).filter((t) => warnCount === t.count).sort((a, b) => b.count - a.count);
  return applicable[0] || null;
}

module.exports = { COLORS, hasModPerms, canTarget, parseDuration, fmtDuration, caseEmbed, postToModLog, computeWarnEscalation, MAX_TIMEOUT_MS };
