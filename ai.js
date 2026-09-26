// Chat IA via l'API Google Gemini (gratuite). Nécessite GEMINI_API_KEY dans
// les variables d'environnement (jamais dans le code ni dans un message
// Discord). Clé à récupérer gratuitement sur https://aistudio.google.com/apikey
//
// Mémoire de conversation : en RAM seulement (par salon + par personne), pas
// en base — c'est un historique de discussion, pas une donnée à garder pour
// toujours, et ça évite de faire grossir la base pour rien. Elle est vidée
// au redémarrage du bot.

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
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

// Le nom "askClaude" est gardé tel quel pour ne pas avoir à toucher index.js
// ailleurs (seul ce fichier change), même si ça parle maintenant à Gemini.
async function askClaude({ channelId, userId, userName, userText, persona }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { error: "La clé GEMINI_API_KEY n'est pas configurée sur le bot." };

  const key = historyKey(channelId, userId);
  pushHistory(key, 'user', userText);
  // Gemini utilise les rôles "user" et "model" (pas "assistant").
  const contents = (histories.get(key) || []).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const system = persona ? `${BASE_SYSTEM_PROMPT}\n\nPersonnalité demandée par le staff : ${persona}` : BASE_SYSTEM_PROMPT;

  try {
    // Limite de temps : si Gemini ne répond pas en 12s, on abandonne proprement
    // au lieu de rester bloqué et de faire planter la commande Discord.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    let res;
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            contents,
            systemInstruction: { parts: [{ text: system }] },
            generationConfig: { maxOutputTokens: 600 },
          }),
          signal: controller.signal,
        }
      );
    } finally {
      clearTimeout(timeout);
    }
    const data = await res.json();
    if (!res.ok) {
      console.error('Erreur API Gemini :', data?.error?.message || res.status);
      return { error: `Erreur API (${data?.error?.status || res.status}) : ${data?.error?.message || 'inconnue'}` };
    }
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('\n').trim() || '(réponse vide)';
    pushHistory(key, 'assistant', text);
    return { text: text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)}…` : text };
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Gemini a mis trop de temps à répondre (12s), abandon.' : e.message;
    console.error('Appel API Gemini impossible :', msg);
    return { error: `Impossible de contacter Gemini (${msg}).` };
  }
}

module.exports = { askClaude, resetHistory };
