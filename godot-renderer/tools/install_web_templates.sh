#!/usr/bin/env bash
# Installs only the Godot web export templates (the full template archive is 1.3 GB; we keep ~80 MB).
# Usage: godot-renderer/tools/install_web_templates.sh [version]   (default 4.7.2)
set -euo pipefail
V="${1:-4.7.2}"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/godot/export_templates/${V}.stable"
case "$(uname)" in Darwin) DEST="$HOME/Library/Application Support/Godot/export_templates/${V}.stable";; esac
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
URL="https://github.com/godotengine/godot/releases/download/${V}-stable/Godot_v${V}-stable_export_templates.tpz"
echo "Downloading $URL"
curl -fL -o "$TMP/t.tpz" "$URL"
unzip -q -o "$TMP/t.tpz" 'templates/web_nothreads_*' 'templates/version.txt' -d "$TMP"
mkdir -p "$DEST" && cp "$TMP"/templates/* "$DEST"/
echo "Installed web templates to $DEST"
