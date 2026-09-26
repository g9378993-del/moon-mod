// Serveur minimal : Render s'en sert pour savoir que l'app est vivante.
// Démarre IMMÉDIATEMENT (voir index.js) — avant même la connexion MongoDB —
// pour que Render ne tue jamais l'app pendant que MongoDB tente de se
// connecter (c'est ce qui causait des redémarrages en boucle sur Moon Bot).
const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('Mod Bot en ligne.'));
app.get('/health', (req, res) => res.send('ok'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur web (santé Render) lancé sur le port ${PORT}`));

module.exports = app;
