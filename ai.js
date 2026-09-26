// Chat IA via l'API Anthropic (Claude). Nécessite ANTHROPIC_API_KEY dans les
// variables d'environnement (jamais dans le code ni dans un message Discord).
//
// Mémoire de conversation : en RAM seulement (par salon + par personne), pas
// en base — c'est un historique de discussion, pas une donnée à garder pour
// toujours, et ça évite de faire grossir la base pour rien. Elle est vidée
// au redémarrage du bot.

const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5';
const MAX_HISTORY_MESSAGES = 12; // 6 échanges question/réponse
const MAX_REPLY_CHARS = 1900;    // marge sous la limite Discord de 2000

const histories = new Map(); // `${channelId}:${userId}` -> [{role, content}, ...]

function historyKey(channelId, userId) { return `${channelId}:${userId}`; }

function pushHistory(key, role, content) {
  const h = histories.get(key) || [];
  h.push({ role, content });
  while (h.length > MAX_HISTORY_MESSAGES) h.shift();
  histories.set(key, h);
}

function resetHistory(channelId, userId) { histories.delete(historyKey(channelId, userId)); }

const BASE_SYSTEM_PROMPT = [
  "Tu es l'assistant IA d'un serveur Discord. Tu discutes avec les membres de façon naturelle, utile et sympathique.",
  "RÈGLE ABSOLUE : réponds TOUJOURS dans la langue utilisée par la personne dans son dernier message, quelle qu'elle soit (français, anglais, arabe, espagnol...), même si les messages précédents étaient dans une autre langue.",
  'Reste concis (Discord affiche mal les pavés de texte) : quelques phrases suffisent, sauf si on te demande explicitement plus de détails.',
  "Tu n'es pas un modérateur : si on te demande de bannir/kick/muter quelqu'un, dis que seul le staff peut faire ça avec les commandes du bot (/ban, /kick, /timeout...).",
].join('\n');

async function askClaude({ channelId, userId, userName, userText, persona }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { error: "La clé ANTHROPIC_API_KEY n'est pas configurée sur le bot." };

  const key = historyKey(channelId, userId);
  pushHistory(key, 'user', userText);
  const messages = (histories.get(key) || []).map((m) => ({ role: m.role, content: m.content }));

  const system = persona ? `${BASE_SYSTEM_PROMPT}\n\nPersonnalité demandée par le staff : ${persona}` : BASE_SYSTEM_PROMPT;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 600, system, messages }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('Erreur API Anthropic :', data?.error?.message || res.status);
      return { error: `Erreur API (${data?.error?.type || res.status}) : ${data?.error?.message || 'inconnue'}` };
    }
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() || '(réponse vide)';
    pushHistory(key, 'assistant', text);
    return { text: text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)}…` : text };
  } catch (e) {
    console.error('Appel API Anthropic impossible :', e.message);
    return { error: `Impossible de contacter Claude (${e.message}).` };
  }
}

module.exports = { askClaude, resetHistory };
