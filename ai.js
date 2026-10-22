// Chat IA avec BASCULE AUTOMATIQUE entre deux fournisseurs gratuits :
//   1) Groq (essayé en premier : plus rapide, quota clairement documenté)
//   2) Gemini (utilisé automatiquement si Groq est indisponible/limité)
// Les deux sont gratuits, sans carte bancaire. Avoir les deux clés remplies
// cumule leurs quotas gratuits respectifs, donc beaucoup moins de coupures.
//
// Clés à mettre dans les variables d'environnement (jamais dans le code ni
// dans un message Discord) :
//   GROQ_API_KEY   → gratuite sur https://console.groq.com/keys
//   GEMINI_API_KEY → gratuite sur https://aistudio.google.com/apikey
// Si une seule des deux est configurée, le bot l'utilise seule (pas de bascule).
//
// Deux "outils" en plus du simple chat :
//  - Recherche YouTube (nécessite une 3e clé gratuite, optionnelle : YOUTUBE_API_KEY)
//  - Lecture du profil d'un membre du serveur (rôles, date d'arrivée...)
//
// Mémoire de conversation : en RAM seulement (par salon + par personne), pas
// en base — c'est un historique de discussion, pas une donnée à garder pour
// toujours, et ça évite de faire grossir la base pour rien. Elle est vidée
// au redémarrage du bot.

const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const MAX_HISTORY_MESSAGES = 4;  // 2 échanges question/réponse (le quota gratuit est très serré)
const MAX_REPLY_CHARS = 1900;    // marge sous la limite Discord de 2000
const MAX_TOOL_ROUNDS = 4;       // sécurité anti-boucle infinie d'appels d'outils
const CALL_TIMEOUT_MS = 40000;

const histories = new Map(); // `${channelId}:${userId}` -> [{role: 'user'|'assistant', content}, ...]

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
  "Si on te demande ton nom ou qui tu es, dis que tu es simplement l'assistant IA de ce serveur Discord. Ne dis JAMAIS que tu es ChatGPT, GPT, OpenAI, Llama, Gemini, ou le produit d'une entreprise en particulier — tu n'as pas de nom de marque à donner.",
  "RÈGLE ABSOLUE : réponds TOUJOURS dans la langue utilisée par la personne dans son dernier message, quelle qu'elle soit (français, anglais, arabe, espagnol...), même si les messages précédents étaient dans une autre langue.",
  'Reste concis (Discord affiche mal les pavés de texte) : quelques phrases suffisent, sauf si on te demande explicitement plus de détails.',
  "Si un membre cherche un salon, un rôle, ou demande où trouver quelque chose sur le serveur, utilise la liste de salons/rôles fournie plus bas pour l'orienter précisément.",
  "Tu as un outil pour chercher des vidéos YouTube (search_youtube) : utilise-le si on te demande une vidéo ou une musique précise, et donne le lien direct trouvé.",
  "Tu as un outil pour lire le profil d'un membre du serveur (get_member_info) : utilise-le si on te demande des infos sur quelqu'un (rôles, date d'arrivée, etc.), y compris sur la personne qui te parle si elle demande 'et moi ?'.",
  "Tu n'as PAS accès à la recherche web en direct : pour des infos très récentes (actus de dernière minute), dis-le honnêtement au lieu d'inventer.",
].join('\n');

const MODERATION_ALLOWED = "Tu as un outil moderate_member (kick/ban/timeout/warn) : la personne qui te parle est membre du staff, donc utilise-le si elle te demande CLAIREMENT et EXPLICITEMENT de sanctionner quelqu'un (ex: 'kick-le', 'ban ce mec pour X', 'timeout 10 minutes'). Trouve d'abord l'ID exact avec get_member_info si tu ne l'as pas déjà. N'utilise JAMAIS cet outil sur une simple mention en passant, une question hypothétique, ou si la cible n'est pas claire — demande une clarification à la place. Confirme toujours dans ta réponse ce que tu as fait (ou pourquoi tu ne l'as pas fait).";
const MODERATION_DENIED = "Tu n'es pas un modérateur pour la personne qui te parle : si elle te demande de bannir/kick/muter/avertir quelqu'un, dis que seul le staff peut faire ça (avec les commandes du bot ou en te le demandant s'il est staff).";

// ------------------------------------------------------------------
// OUTILS (functions) — description commune, adaptée au format de chaque fournisseur
// ------------------------------------------------------------------

const TOOL_SPECS = [
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

const MODERATE_TOOL = {
  name: 'moderate_member',
  description: "Effectue une VRAIE action de modération (kick, ban, timeout ou warn) sur un membre du serveur. N'est disponible que quand la personne qui te parle est staff. Utilise-le uniquement sur une demande claire et explicite, jamais sur une simple mention en passant.",
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['kick', 'ban', 'timeout', 'warn'], description: "L'action à effectuer." },
      user_id: { type: 'string', description: "L'ID Discord exact du membre visé (utilise get_member_info avant si tu ne l'as pas)." },
      reason: { type: 'string', description: 'La raison de la sanction.' },
      duration: { type: 'string', description: "Durée, uniquement pour 'timeout' (ex: '10m', '2h', '1d')." },
    },
    required: ['action', 'user_id', 'reason'],
  },
};

function getToolSpecs(canModerate) {
  return canModerate ? [...TOOL_SPECS, MODERATE_TOOL] : TOOL_SPECS;
}

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

async function runFunctionCall(name, args, guild, modExecutor) {
  if (name === 'search_youtube') return execSearchYoutube(args.query);
  if (name === 'get_member_info') return execGetMemberInfo(args.query, guild);
  if (name === 'moderate_member') {
    if (!modExecutor) return { error: "Action de modération non autorisée dans ce contexte." };
    try { return await modExecutor(args); } catch (e) { return { error: e.message }; }
  }
  return { error: `Fonction inconnue : ${name}` };
}

// ------------------------------------------------------------------
// FOURNISSEUR 1 : GROQ (format OpenAI)
// ------------------------------------------------------------------

async function callGroqOnce(apiKey, messages, canModerate) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        tools: getToolSpecs(canModerate).map((t) => ({ type: 'function', function: t })),
        max_tokens: 500,
      }),
      signal: controller.signal,
    });
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data?.error?.message || `Erreur API (${res.status})`);
      err.apiStatus = data?.error?.code || data?.error?.type || res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

// Si l'erreur indique un délai d'attente court ("réessaie dans X secondes" —
// Groq et Gemini formulent ça différemment mais donnent toujours un chiffre),
// on attend ce délai puis on retente UNE fois, invisible pour l'utilisateur.
// Sans ce délai dans le message (ex: quota journalier épuisé), pas de retry :
// ça ne servirait à rien et ferait juste attendre l'utilisateur pour rien.
async function withRetry(fn) {
  try {
    return await fn();
  } catch (e) {
    const m = String(e.message).match(/(?:try again|retry) in ([\d.]+)\s*s/i);
    if (!m) throw e;
    const waitMs = Math.min(Math.ceil(parseFloat(m[1]) * 1000) + 300, 15000);
    await new Promise((r) => setTimeout(r, waitMs));
    return fn();
  }
}


function isQuotaError(e) {
  const msg = String(e.message || '').toLowerCase();
  const status = String(e.apiStatus || '').toUpperCase();
  // Daily quota exhausted — no retry possible
  return (
    status === 'RESOURCE_EXHAUSTED' ||
    msg.includes('quota') ||
    msg.includes('daily') ||
    (msg.includes('rate_limit_exceeded') && !msg.match(/try again in [\d.]+s/i))
  );
}

async function tryGroq({ system, historyMsgs, guild, canModerate, modExecutor }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY non configurée');

  let messages = [{ role: 'system', content: system }, ...historyMsgs];
  let data = await callGroqOnce(apiKey, messages, canModerate);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const msg = data.choices?.[0]?.message;
    const calls = msg?.tool_calls || [];
    if (!calls.length) break;
    messages = [...messages, msg];
    for (const c of calls) {
      let args = {};
      try { args = JSON.parse(c.function.arguments || '{}'); } catch { /* args invalides */ }
      const result = await runFunctionCall(c.function.name, args, guild, modExecutor);
      messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result) });
    }
    data = await callGroqOnce(apiKey, messages, canModerate);
  }

  return (data.choices?.[0]?.message?.content || '').trim();
}

// ------------------------------------------------------------------
// FOURNISSEUR 2 : GEMINI (format Google)
// ------------------------------------------------------------------

async function callGeminiOnce(apiKey, system, contents, canModerate) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents,
          systemInstruction: { parts: [{ text: system }] },
          tools: [{ functionDeclarations: getToolSpecs(canModerate) }],
          generationConfig: { maxOutputTokens: 500 },
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

async function tryGemini({ system, historyMsgs, guild, canModerate, modExecutor }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY non configurée');

  // Gemini utilise les rôles "user" et "model" (pas "assistant").
  let contents = historyMsgs.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  let data = await callGeminiOnce(apiKey, system, contents, canModerate);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const parts = data.candidates?.[0]?.content?.parts || [];
    const calls = parts.filter((p) => p.functionCall);
    if (!calls.length) break;
    contents = [...contents, { role: 'model', parts }];
    const responseParts = [];
    for (const c of calls) {
      const result = await runFunctionCall(c.functionCall.name, c.functionCall.args || {}, guild, modExecutor);
      responseParts.push({ functionResponse: { name: c.functionCall.name, response: result } });
    }
    contents = [...contents, { role: 'function', parts: responseParts }];
    data = await callGeminiOnce(apiKey, system, contents, canModerate);
  }

  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('\n').trim();
}

// ------------------------------------------------------------------

// Le nom "askClaude" est gardé tel quel pour ne pas avoir à toucher index.js
// ailleurs (seul ce fichier change), même si ça parle à Groq/Gemini.
async function askClaude({ channelId, userId, userName, userText, persona, serverContext, speakerInfo, guild, canModerate, modExecutor }) {
  if (!process.env.GROQ_API_KEY && !process.env.GEMINI_API_KEY) {
    return { error: "Aucune clé IA configurée (GROQ_API_KEY ou GEMINI_API_KEY manquantes)." };
  }

  const key = historyKey(channelId, userId);
  pushHistory(key, 'user', userText);
  const historyMsgs = (histories.get(key) || []).map((m) => ({ role: m.role, content: m.content }));

  const system = [
    persona ? `${BASE_SYSTEM_PROMPT}\n\nPersonnalité demandée par le staff : ${persona}` : BASE_SYSTEM_PROMPT,
    canModerate ? MODERATION_ALLOWED : MODERATION_DENIED,
    speakerInfo ? `\n${speakerInfo}` : '',
    serverContext
      ? `\nVoici la structure de CE serveur Discord (pour orienter les membres et répondre à des questions comme "où est le salon X ?" ou "quel rôle pour Y ?") :\n${serverContext}\nQuand tu mentionnes un salon ou un rôle de cette liste, utilise EXACTEMENT le format <#id> ou <@&id> donné entre parenthèses (ça devient un lien/mention cliquable pour la personne). N'invente jamais un salon ou un rôle qui n'est pas dans cette liste.`
      : '',
  ].filter(Boolean).join('\n');

  const errors = [];
  let groqQuota = false;
  let geminiQuota = false;

  if (process.env.GROQ_API_KEY) {
    try {
      const text = await withRetry(() => tryGroq({ system, historyMsgs, guild, canModerate, modExecutor }));
      if (text) {
        pushHistory(key, 'assistant', text);
        return { text: text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)}…` : text };
      }
      errors.push('Groq : réponse vide');
    } catch (e) {
      if (isQuotaError(e)) groqQuota = true;
      const msg = e.name === 'AbortError' ? 'délai dépassé' : (e.apiStatus ? `${e.apiStatus} : ${e.message}` : e.message);
      console.error('Groq indisponible, bascule sur Gemini :', msg);
      errors.push(`Groq (${msg})`);
    }
  } else {
    groqQuota = true; // pas configuré = considéré épuisé pour le calcul
  }

  if (process.env.GEMINI_API_KEY) {
    try {
      const text = await withRetry(() => tryGemini({ system, historyMsgs, guild, canModerate, modExecutor }));
      if (text) {
        pushHistory(key, 'assistant', text);
        return { text: text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)}…` : text };
      }
      errors.push('Gemini : réponse vide');
    } catch (e) {
      if (isQuotaError(e)) geminiQuota = true;
      const msg = e.name === 'AbortError' ? 'délai dépassé' : (e.apiStatus ? `${e.apiStatus} : ${e.message}` : e.message);
      console.error('Gemini indisponible :', msg);
      errors.push(`Gemini (${msg})`);
    }
  } else {
    geminiQuota = true; // pas configuré
  }

  // Les deux sont épuisées (quota journalier) — pas une panne temporaire
  const quotaExhausted = groqQuota && geminiQuota;
  return { error: `Les deux IA sont indisponibles pour le moment : ${errors.join(' | ')}`, quotaExhausted };
}

module.exports = { askClaude, resetHistory };
