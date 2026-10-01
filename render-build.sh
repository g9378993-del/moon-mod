#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# Render build script — moon-bot
# Installe les dépendances Node + Python et build luau pour Linux
# ═══════════════════════════════════════════════════════════
set -e

echo "[render-build] Installing Node dependencies..."
npm install

echo "[render-build] Installing Python dependencies..."
python3 -m pip install --quiet --upgrade pip

# Check if luau already built (persiste si Render persistent disk actif)
LUAU_BIN="deobf/bin/luau"
if [ -f "$LUAU_BIN" ]; then
    echo "[render-build] luau already built: $($LUAU_BIN --version 2>&1 || echo 'ok')"
    exit 0
fi

echo "[render-build] Building luau from source (needs ~3 min)..."

# Render Ubuntu a cmake, g++, git
apt-get install -y cmake g++ git > /dev/null 2>&1 || true

python3 deobf/build_luau.py --portable
echo "[render-build] luau built: $(deobf/bin/luau --version 2>&1)"

echo "[render-build] Done."
