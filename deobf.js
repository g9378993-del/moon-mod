// ═══════════════════════════════════════════════════════════════
// /deobf  —  Commande Discord | Moon Bot
// Déobfusque un script Lua/Luau uploadé
// Supporte : Luraph v14/v15, IronBrew1, Generic (behaviour trace)
// ═══════════════════════════════════════════════════════════════
const { SlashCommandBuilder, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const { execFile } = require('child_process');
const { promisify }  = require('util');
const execFileAsync  = promisify(execFile);
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const https = require('https');
const http  = require('http');

const DEOBF_PY   = path.join(__dirname, '..', 'deobf', 'deob.py');
const PYTHON     = process.platform === 'win32' ? 'python' : 'python3';
const MAX_BYTES  = 4 * 1024 * 1024;   // 4 MB — au-delà le deobf devient lent
const TIMEOUT_MS = 5 * 60 * 1000;     // 5 min max par deobf

// ─── UTIL : télécharge un fichier Discord ──────────────────────
function downloadToTemp(url, ext) {
    return new Promise((resolve, reject) => {
        const tmp  = path.join(os.tmpdir(), `deobf_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
        const file = fs.createWriteStream(tmp);
        const mod  = url.startsWith('https') ? https : http;
        mod.get(url, res => {
            if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
            res.pipe(file);
            file.on('finish', () => file.close(() => resolve(tmp)));
        }).on('error', reject);
    });
}

// ─── UTIL : détecte quel obfuscateur sans lancer le pipeline complet
async function detectObfuscator(inputPath) {
    try {
        const { stdout } = await execFileAsync(PYTHON, [DEOBF_PY, inputPath, '--detect'], {
            timeout: 15_000,
            cwd: path.dirname(DEOBF_PY),
        });
        return stdout.trim() || 'inconnu';
    } catch {
        return 'inconnu';
    }
}

// ─── UTIL : lance le pipeline deobf complet ───────────────────
async function runDeobf(inputPath, noDevirt = false) {
    const args = [DEOBF_PY, inputPath];
    if (noDevirt) args.push('--no-devirt');

    const outDir = path.join(path.dirname(inputPath), 'output');
    fs.mkdirSync(outDir, { recursive: true });

    const { stdout, stderr } = await execFileAsync(PYTHON, args, {
        timeout: TIMEOUT_MS,
        cwd: path.dirname(DEOBF_PY),
        maxBuffer: 20 * 1024 * 1024,
    });

    // deob.py écrit dans <inputDir>/output/<name>
    const base    = path.basename(inputPath).replace(/\.[^.]+$/, '');
    const outFile = path.join(outDir, base + '.lua');
    if (fs.existsSync(outFile)) return { outFile, stdout, stderr };

    // fallback : cherche n'importe quel fichier .lua dans output/
    const files = fs.readdirSync(outDir).filter(f => f.endsWith('.lua') || f.endsWith('.luau'));
    if (files.length) return { outFile: path.join(outDir, files[0]), stdout, stderr };

    throw new Error('Fichier de sortie introuvable.\n' + (stderr || stdout).slice(0, 500));
}

// ─── CLEANUP ──────────────────────────────────────────────────
function cleanup(...paths) {
    for (const p of paths) {
        try {
            if (fs.existsSync(p)) {
                const stat = fs.statSync(p);
                if (stat.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
                else fs.unlinkSync(p);
            }
        } catch { /* silent */ }
    }
}

// ═══════════════════════════════════════════════════════════════
// COMMAND DEFINITION
// ═══════════════════════════════════════════════════════════════
module.exports = {
    data: new SlashCommandBuilder()
        .setName('deobf')
        .setDescription('Déobfusque un script Lua/Luau (Luraph, IronBrew, Generic)')
        .addAttachmentOption(opt =>
            opt.setName('fichier')
               .setDescription('Fichier .lua / .luau / .txt à déobfusquer')
               .setRequired(true)
        )
        .addBooleanOption(opt =>
            opt.setName('rapide')
               .setDescription('Mode rapide (behaviour trace sans lifting — résultat moins lisible)')
               .setRequired(false)
        )
        .addBooleanOption(opt =>
            opt.setName('detect_seulement')
               .setDescription("Détecte l'obfuscateur sans déobfusquer")
               .setRequired(false)
        ),

    async execute(interaction) {
        const attachment    = interaction.options.getAttachment('fichier');
        const noDevirt      = interaction.options.getBoolean('rapide')         ?? false;
        const detectOnly    = interaction.options.getBoolean('detect_seulement') ?? false;

        // ── validations ───────────────────────────────────────
        const validExts = ['.lua', '.luau', '.txt'];
        const ext       = path.extname(attachment.name).toLowerCase();
        if (!validExts.includes(ext)) {
            return interaction.reply({
                content: `❌ Extension non supportée \`${ext}\`. Envoie un fichier \`.lua\`, \`.luau\` ou \`.txt\`.`,
                ephemeral: true,
            });
        }
        if (attachment.size > MAX_BYTES) {
            return interaction.reply({
                content: `❌ Fichier trop lourd (${(attachment.size/1024/1024).toFixed(1)} MB). Max 4 MB.`,
                ephemeral: true,
            });
        }

        // ── defer (peut prendre plusieurs minutes) ────────────
        await interaction.deferReply();

        let inputPath = null;
        const startMs = Date.now();

        try {
            // ── télécharge le fichier ─────────────────────────
            inputPath = await downloadToTemp(attachment.url, ext);

            // ── mode detect only ──────────────────────────────
            if (detectOnly) {
                const obf = await detectObfuscator(inputPath);
                const embed = new EmbedBuilder()
                    .setTitle('🔍 Détection obfuscateur')
                    .setDescription(`**Fichier :** \`${attachment.name}\`\n**Obfuscateur détecté :** \`${obf}\``)
                    .setColor(0x5865F2)
                    .setFooter({ text: 'Moon Bot • Deobf' })
                    .setTimestamp();
                return interaction.editReply({ embeds: [embed] });
            }

            // ── detect d'abord pour l'embed ───────────────────
            const obf = await detectObfuscator(inputPath);

            // ── run pipeline ──────────────────────────────────
            const { outFile, stderr } = await runDeobf(inputPath, noDevirt);
            const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
            const outSize = fs.statSync(outFile).size;

            // ── résultat trop gros pour Discord (8MB) ? ───────
            if (outSize > 8 * 1024 * 1024) {
                return interaction.editReply({
                    content: `⚠️ Résultat trop lourd pour Discord (${(outSize/1024/1024).toFixed(1)} MB). Contacte un admin.`,
                });
            }

            // ── envoie le fichier déobfusqué ──────────────────
            const outName = path.basename(outFile);
            const file    = new AttachmentBuilder(outFile, { name: outName });

            const warnings = (stderr || '')
                .split('\n')
                .filter(l => l.includes('Warning') || l.includes('warning'))
                .slice(0, 3)
                .join('\n');

            const embed = new EmbedBuilder()
                .setTitle('✅ Déobfuscation terminée')
                .addFields(
                    { name: '📄 Fichier',       value: `\`${attachment.name}\``,         inline: true  },
                    { name: '🔍 Obfuscateur',   value: `\`${obf}\``,                     inline: true  },
                    { name: '⏱️ Durée',          value: `${elapsed}s`,                   inline: true  },
                    { name: '📦 Taille sortie', value: `${(outSize/1024).toFixed(1)} KB`, inline: true  },
                    { name: '⚡ Mode',           value: noDevirt ? 'Rapide (no-devirt)' : 'Complet',    inline: true },
                )
                .setColor(0x57F287)
                .setFooter({ text: 'Moon Bot • Deobf' })
                .setTimestamp();

            if (warnings) {
                embed.addFields({ name: '⚠️ Warnings', value: `\`\`\`\n${warnings}\n\`\`\`` });
            }

            return interaction.editReply({ embeds: [embed], files: [file] });

        } catch (err) {
            const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
            const msg     = err.message || String(err);

            // Timeout spécifique
            const isTimeout = msg.includes('ETIMEDOUT') || msg.includes('timed out') || elapsed > 290;

            const embed = new EmbedBuilder()
                .setTitle('❌ Échec de la déobfuscation')
                .setDescription(isTimeout
                    ? `Timeout après ${elapsed}s. Le script est peut-être trop gros ou utilise un obfuscateur non supporté.\nEssaie le mode **rapide** (\`/deobf rapide:True\`).`
                    : `\`\`\`\n${msg.slice(0, 1000)}\n\`\`\``
                )
                .setColor(0xED4245)
                .setFooter({ text: 'Moon Bot • Deobf' })
                .setTimestamp();

            return interaction.editReply({ embeds: [embed] });

        } finally {
            // Nettoyage fichiers temp
            if (inputPath) {
                const outDir = path.join(path.dirname(inputPath), 'output');
                cleanup(inputPath, outDir);
            }
        }
    },
};
