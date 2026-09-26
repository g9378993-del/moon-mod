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
  "Si un membre cherche un salon, un rôle, ou demande où trouver quelque chose sur le serveur, utilise la liste de salons/rôles fournie plus bas pour l'orienter précisément.",
  "Tu sais toujours quel(s) rôle(s) a la personne qui te parle (indiqué plus bas) : sers-t'en pour être précis, par exemple pour adapter ton ton ou confirmer ce qu'elle peut faire selon son rôle.",
  "Si le contexte plus bas indique les rôles d'une ou plusieurs personnes @mentionnées dans le message, utilise-les pour répondre précisément à des questions comme \"quel rôle a untel ?\". Si personne n'est mentionné, tu ne connais que le rôle de la personne qui te parle, pas celui des autres membres du serveur — dis-le simplement si on te demande le rôle de quelqu'un sans le @mentionner.",
  "La liste des salons fournie plus bas est déjà filtrée : elle ne contient QUE les salons que CETTE personne peut voir vu son/ses rôle(s). Ne propose donc jamais un salon en dehors de cette liste, et si elle demande un salon qui n'y figure pas, dis-lui simplement que tu ne le vois pas depuis son rôle actuel (sans jamais révéler le nom d'un salon caché).",
].join('\n');

// Le nom "askClaude" est gardé tel quel pour ne pas avoir à toucher index.js
// ailleurs (seul ce fichier change), même si ça parle maintenant à Gemini.
async function askClaude({ channelId, userId, userName, userText, persona, serverContext }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { error: "La clé GEMINI_API_KEY n'est pas configurée sur le bot." };

  const key = historyKey(channelId, userId);
  pushHistory(key, 'user', userText);
  // Gemini utilise les rôles "user" et "model" (pas "assistant").
  const contents = (histories.get(key) || []).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const system = [
    persona ? `${BASE_SYSTEM_PROMPT}\n\nPersonnalité demandée par le staff : ${persona}` : BASE_SYSTEM_PROMPT,
    serverContext
      ? `\nVoici le rôle de la personne qui te parle et la structure de CE serveur Discord (pour orienter les membres et répondre à des questions comme "où est le salon X ?" ou "quel rôle pour Y ?") :\n${serverContext}\nQuand tu mentionnes un salon ou un rôle de cette liste, utilise EXACTEMENT le format <#id> ou <@&id> donné entre parenthèses (ça devient un lien/mention cliquable pour la personne). N'invente jamais un salon ou un rôle qui n'est pas dans cette liste, et ne suggère un salon que s'il apparaît dans la liste des salons visibles par cette personne.`
      : '',
  ].filter(Boolean).join('\n');

  try {
    // Limite de temps : si Gemini ne répond pas en 40s, on abandonne proprement
    // au lieu de rester bloqué et de faire planter la commande Discord.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 40000);
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
    const msg = e.name === 'AbortError' ? 'Gemini a mis trop de temps à répondre (40s), abandon.' : e.message;
    console.error('Appel API Gemini impossible :', msg);
    return { error: `Impossible de contacter Gemini (${msg}).` };
  }
}

module.exports = { askClaude, resetHistory };
