// Stockage PAR SERVEUR (chaque serveur a sa propre config, ses warns, etc.).
// Même principe que Moon Bot : MongoDB si MONGODB_URI est configuré, sinon
// fichier local (non persistant entre redéploiements Render).

const fs = require('fs');
const path = require('path');
let MongoClient;
try { MongoClient = require('mongodb').MongoClient; } catch (e) { MongoClient = null; }

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const STORE_FILE = path.join(DATA_DIR, 'store.json');

function defaultGuild() {
  return {
    staffRoles: [],           // rôles (en plus d'Administrateur/Gérer le serveur) autorisés à modérer
    modLogChannelId: null,    // salon où sont postés kick/ban/warn/etc.
    constructionMode: false,  // mode construction du serveur (gestion des salons)
    nextCaseId: 1,
    cases: [],                // { id, type, userId, moderatorId, reason, createdAt, extra }
    automod: {
      antiLink: { enabled: false },
      antiSpam: { enabled: true, maxMessages: 6, perSeconds: 7, timeoutMinutes: 10 },
      antiMention: { enabled: true, maxMentions: 5, timeoutMinutes: 10 },
      badWords: { enabled: false, words: [] },
      profanity: { enabled: true },  // filtre intégré multilingue de gros mots (/automod grosmots)
      antiRaid: { enabled: true, joinThreshold: 6, windowSeconds: 20, minAccountAgeDays: 3, action: 'timeout' }, // action: 'timeout' | 'kick' | 'alert_only'
      antialts: { enabled: false, minAccountAgeDays: 7, action: 'kick' }, // action: 'kick' | 'timeout'
    },
    warnThresholds: [
      { count: 3, action: 'timeout', minutes: 60 },
      { count: 5, action: 'timeout', minutes: 1440 },
      { count: 7, action: 'ban', minutes: null },
    ],
    lockedChannels: {},       // channelId -> permissions @everyone d'avant verrouillage (pour /unlock)
    aiChannels: [],           // salons où l'IA répond à TOUS les messages, pas juste aux mentions
    aiEnabled: true,          // interrupteur général : répondre quand le bot est mentionné
    aiLanguage: null,         // langue principale par défaut (/language), ex: "français", "english"...
    aiPersona: null,          // instruction supplémentaire optionnelle (ton, personnalité)
    cmdPerms: {},             // commande -> [roleId] autorisés en plus du staff (/permscmnds)
    tickets: {
      enabled: false,
      categoryId: null,       // catégorie où sont créés les salons de tickets
      supportRoleId: null,    // rôle support ajouté automatiquement à chaque ticket
      panelChannelId: null,   // salon où est posté le panneau (/ticket panel)
      panelMessageId: null,
      welcomeMessage: null,   // message d'accueil personnalisé optionnel
      counter: 1,             // numéro du prochain ticket
      open: {},                // channelId -> { userId, claimedBy, createdAt, number }
    },
  };
}
function defaultUser() {
  return {
    language: null, // code ISO 639-1 (ex: 'fr', 'en', 'es') détecté lors du dernier échange avec l'IA
  };
}
function normalizeGuild(data) {
  const base = defaultGuild();
  const d = data || {};
  return {
    ...base, ...d,
    automod: {
      antiLink: { ...base.automod.antiLink, ...(d.automod?.antiLink || {}) },
      antiSpam: { ...base.automod.antiSpam, ...(d.automod?.antiSpam || {}) },
      antiMention: { ...base.automod.antiMention, ...(d.automod?.antiMention || {}) },
      badWords: { ...base.automod.badWords, ...(d.automod?.badWords || {}) },
      profanity: { ...base.automod.profanity, ...(d.automod?.profanity || {}) },
      antiRaid: { ...base.automod.antiRaid, ...(d.automod?.antiRaid || {}) },
      antialts: { ...base.automod.antialts, ...(d.automod?.antialts || {}) },
    },
    tickets: {
      ...base.tickets,
      ...(d.tickets || {}),
      open: { ...(d.tickets?.open || {}) },
    },
  };
}

const state = { guilds: {}, users: {} };
let collection = null;
let mongoReady = false;
const status = { uriSet: false, mongoConnected: false, connectError: null, lastSaveError: null };

function readLocalStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    for (const [id, g] of Object.entries(raw.guilds || {})) state.guilds[id] = normalizeGuild(g);
    for (const [id, u] of Object.entries(raw.users || {})) state.users[id] = { ...defaultUser(), ...u };
  } catch (e) { /* premier démarrage : rien à lire */ }
}
function writeLocalStore() {
  try { fs.writeFileSync(STORE_FILE, JSON.stringify(state)); }
  catch (e) { console.error('Écriture locale impossible :', e.message); }
}

async function connectMongo(uri) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
      await client.connect();
      return client;
    } catch (e) {
      status.connectError = e.message;
      console.error(`Connexion MongoDB échouée (essai ${attempt}/2) :`, e.message);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return null;
}

// IMPORTANT : le serveur web (server.js) doit démarrer AVANT que cette
// fonction soit attendue, sinon Render tue l'app pendant les tentatives
// MongoDB (voir index.js, ordre de démarrage).
async function initDb() {
  const uri = process.env.MONGODB_URI;
  status.uriSet = !!uri;

  if (uri && !MongoClient) status.connectError = "le paquet 'mongodb' n'est pas installé";
  if (uri && MongoClient) {
    const client = await connectMongo(uri);
    if (client) {
      try {
        collection = client.db('modbot').collection('store');
        const docs = await collection.find({}).toArray();
        for (const doc of docs) {
          const id = String(doc._id);
          if (id.startsWith('guild:')) state.guilds[id.slice(6)] = normalizeGuild(doc.data);
          else if (id.startsWith('user:')) state.users[id.slice(5)] = { ...defaultUser(), ...doc.data };
        }
        mongoReady = true;
        status.mongoConnected = true;
        status.connectError = null;
        console.log(`MongoDB connecté — données persistantes activées (${Object.keys(state.guilds).length} serveur(s) chargé(s)).`);
      } catch (e) {
        status.connectError = e.message;
        console.error('Lecture MongoDB impossible :', e.message);
      }
    }
    if (!mongoReady) console.error('⚠️ MongoDB inaccessible : le bot tourne SANS stockage persistant.');
  } else {
    console.log('MongoDB non configuré (MONGODB_URI absent) : stockage local uniquement, NON persistant sur Render.');
  }
  if (!mongoReady) readLocalStore();
}

function peek(guildId) { return state.guilds[guildId] || null; }
function get(guildId) {
  if (!state.guilds[guildId]) state.guilds[guildId] = defaultGuild();
  return state.guilds[guildId];
}
// Stockage PAR UTILISATEUR, indépendant des serveurs : sert uniquement à
// retenir la langue avec laquelle l'IA doit lui parler, pour lui répondre
// pareil la prochaine fois même sur un autre salon/serveur.
function peekUser(userId) { return state.users[userId] || null; }
function getUser(userId) {
  if (!state.users[userId]) state.users[userId] = defaultUser();
  return state.users[userId];
}
function getStatus() { return { ...status, persistent: mongoReady }; }

async function mongoWrite(id, data) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { await collection.updateOne({ _id: id }, { $set: { data } }, { upsert: true }); status.lastSaveError = null; return; }
    catch (e) { status.lastSaveError = e.message; console.error(`Erreur écriture MongoDB (essai ${attempt}/2) :`, e.message); }
  }
}
async function save(guildId) {
  writeLocalStore();
  if (mongoReady && collection && state.guilds[guildId]) await mongoWrite(`guild:${guildId}`, state.guilds[guildId]);
}
async function saveUser(userId) {
  writeLocalStore();
  if (mongoReady && collection && state.users[userId]) await mongoWrite(`user:${userId}`, state.users[userId]);
}

// Ajoute un cas de modération (kick/ban/warn/timeout/automod...) et renvoie
// son numéro. Toujours appelé + suivi d'un db.save(guildId) par l'appelant.
function addCase(g, { type, userId, moderatorId, reason, extra }) {
  const record = { id: g.nextCaseId++, type, userId, moderatorId, reason: reason || 'Aucune raison fournie', extra: extra || null, createdAt: Date.now() };
  g.cases.push(record);
  if (g.cases.length > 2000) g.cases = g.cases.slice(-2000); // garde-fou, évite une croissance infinie
  return record;
}

module.exports = { initDb, peek, get, save, getStatus, addCase, defaultGuild, peekUser, getUser, saveUser };
