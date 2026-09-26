// Chat IA via l'API Google Gemini (gratuite). Nécessite GEMINI_API_KEY dans
// les variables d'environnement (jamais dans le code ni dans un message
// Discord). Clé à récupérer gratuitement sur https://aistudio.google.com/apikey
//
// Deux "outils" en plus du simple chat :
//  - Recherche Google intégrée à Gemini (jeux Roblox, infos générales, actus...)
//  - Recherche YouTube (nécessite une 2e clé gratuite, optionnelle : YOUTUBE_API_KEY)
//  - Lecture du profil d'un membre du serveur (rôles, date d'arrivée...)
//
// Mémoire de conversation : en RAM seulement (par salon + par personne), pas
// en base — c'est un historique de discussion, pas une donnée à garder pour
// toujours, et ça évite de faire grossir la base pour rien. Elle est vidée
// au redémarrage du bot.

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const MAX_HISTORY_MESSAGES = 12; // 6 échanges question/réponse
const MAX_REPLY_CHARS = 1900;    // marge sous la limite Discord de 2000
const MAX_TOOL_ROUNDS = 4;       // sécurité anti-boucle infinie d'appels d'outils

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
  "Tu as un outil pour chercher des vidéos YouTube (search_youtube) : utilise-le si on te demande une vidéo ou une musique précise, et donne le lien direct trouvé.",
  "Tu as un outil pour lire le profil d'un membre du serveur (get_member_info) : utilise-le si on te demande des infos sur quelqu'un (rôles, date d'arrivée, etc.), y compris sur la personne qui te parle si elle demande 'et moi ?'.",
].join('\n');

// ------------------------------------------------------------------
// OUTILS (functions) QUE GEMINI PEUT APPELER
// ------------------------------------------------------------------

const FUNCTION_DECLARATIONS = [
  {
    name: 'search_youtube',
    description: "Cherche une vidéo ou une musique sur YouTube et renvoie le titre et le lien direct des meilleurs résultats.",
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Termes de recherche (titre de vidéo, nom de musique/artiste...)' } },
      required: ['query'],
    },
  },
  {
    name: 'get_member_info',
    description: "Renvoie les infos d'un membre du serveur Discord (pseudo, rôles, date d'arrivée sur le serveur, date de création du compte). Cherche par pseudo, surnom, ou mention.",
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: "Nom, pseudo ou mention (ex: '@Jean' ou 'Jean') de la personne recherchée." } },
      required: ['query'],
    },
  },
];

async function execSearchYoutube(query) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return { error: "La recherche YouTube n'est pas configurée (il manque YOUTUBE_API_KEY, une clé gratuite à ajouter par le staff)." };
  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=3&q=${encodeURIComponent(query)}&key=${key}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) return { error: `Erreur YouTube API : ${data?.error?.message || res.status}` };
    const items = (data.items || []).map((it) => ({
      titre: it.snippet?.title,
      chaine: it.snippet?.channelTitle,
      lien: `https://www.youtube.com/watch?v=${it.id?.videoId}`,
    }));
    return { resultats: items.length ? items : 'aucun résultat' };
  } catch (e) {
    return { error: `Recherche YouTube impossible (${e.message}).` };
  }
}

// `guild` (objet discord.js) est injecté par index.js à chaque appel, pas stocké.
async function execGetMemberInfo(query, guild) {
  if (!guild) return { error: 'Aucun serveur associé à cette conversation.' };
  const q = query.replace(/[<@!>]/g, '').trim().toLowerCase();
  const member = guild.members.cache.find((m) => (
    m.id === q
    || m.user.username.toLowerCase() === q
    || m.displayName.toLowerCase() === q
    || m.user.username.toLowerCase().includes(q)
    || m.displayName.toLowerCase().includes(q)
  ));
  if (!member) return { error: `Aucun membre trouvé pour "${query}".` };
  const roles = member.roles.cache.filter((r) => r.id !== guild.id).map((r) => r.name);
  return {
    pseudo: member.user.username,
    surnom_serveur: member.displayName,
    id: member.id,
    roles: roles.length ? roles : 'aucun',
    a_rejoint_le: member.joinedAt ? member.joinedAt.toISOString().slice(0, 10) : 'inconnu',
    compte_cree_le: member.user.createdAt.toISOString().slice(0, 10),
    est_un_bot: member.user.bot,
  };
}

async function runFunctionCall(name, args, guild) {
  if (name === 'search_youtube') return execSearchYoutube(args.query);
  if (name === 'get_member_info') return execGetMemberInfo(args.query, guild);
  return { error: `Fonction inconnue : ${name}` };
}

// ------------------------------------------------------------------

// Le nom "askClaude" est gardé tel quel pour ne pas avoir à toucher index.js
// ailleurs (seul ce fichier change), même si ça parle maintenant à Gemini.
async function askClaude({ channelId, userId, userName, userText, persona, serverContext, speakerInfo, guild }) {
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
    speakerInfo ? `\n${speakerInfo}` : '',
    serverContext
      ? `\nVoici la structure de CE serveur Discord (pour orienter les membres et répondre à des questions comme "où est le salon X ?" ou "quel rôle pour Y ?") :\n${serverContext}\nQuand tu mentionnes un salon ou un rôle de cette liste, utilise EXACTEMENT le format <#id> ou <@&id> donné entre parenthèses (ça devient un lien/mention cliquable pour la personne). N'invente jamais un salon ou un rôle qui n'est pas dans cette liste.`
      : '',
  ].filter(Boolean).join('\n');

  const tools = [
    { functionDeclarations: FUNCTION_DECLARATIONS },
  ];

  async function callGemini(currentContents) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 40000);
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: currentContents,
            systemInstruction: { parts: [{ text: system }] },
            tools,
            generationConfig: { maxOutputTokens: 700 },
          }),
          signal: controller.signal,
        }
      );
      const data = await res.json();
      if (!res.ok) {
        const err = new Error(data?.error?.message || `Erreur API (${res.status})`);
        err.apiStatus = data?.error?.status || res.status;
        throw err;
      }
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  try {
    let workingContents = contents;
    let data = await callGemini(workingContents);

    // Boucle d'appels d'outils : tant que Gemini demande une fonction, on
    // l'exécute et on lui renvoie le résultat, jusqu'à une vraie réponse texte.
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const parts = data.candidates?.[0]?.content?.parts || [];
      const calls = parts.filter((p) => p.functionCall);
      if (!calls.length) break;

      // On rejoue le tour du modèle (avec ses appels de fonction) + nos réponses.
      workingContents = [...workingContents, { role: 'model', parts }];
      const responseParts = [];
      for (const c of calls) {
        const result = await runFunctionCall(c.functionCall.name, c.functionCall.args || {}, guild);
        responseParts.push({ functionResponse: { name: c.functionCall.name, response: result } });
      }
      workingContents = [...workingContents, { role: 'function', parts: responseParts }];
      data = await callGemini(workingContents);
    }

    const finalParts = data.candidates?.[0]?.content?.parts || [];
    const text = finalParts.map((p) => p.text || '').join('\n').trim() || '(réponse vide)';
    pushHistory(key, 'assistant', text);
    return { text: text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)}…` : text };
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Gemini a mis trop de temps à répondre (40s), abandon.' : (e.apiStatus ? `${e.apiStatus} : ${e.message}` : e.message);
    console.error('Appel API Gemini impossible :', msg);
    return { error: `Impossible de contacter Gemini (${msg}).` };
  }
}

module.exports = { askClaude, resetHistory };
