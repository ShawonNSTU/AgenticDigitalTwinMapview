#!/usr/bin/env bash
# Every room on the floor the web app serves can be walked into from the lift lobby (or the floor's best-connected
# room), through the doors the plan has: no room needs a guessed doorway. Needs the web app running (TWIN, default
# http://localhost:3000 is what the renderer reads) and Godot 4 (GODOT, default "godot"); a display or xvfb-run.
set -euo pipefail
GODOT="${GODOT:-godot}"
here="$(cd "$(dirname "$0")/.." && pwd)"
log="$(mktemp)"
run=(timeout 600 "$GODOT" --rendering-driver opengl3 --path "$here/godot-renderer" -- --routes='*')
if [ -z "${DISPLAY:-}" ] && command -v xvfb-run >/dev/null; then run=(xvfb-run -a "${run[@]}"); fi
"${run[@]}" > "$log" 2>&1 || true
grep -E "^(WALK|NO WAY IN|AUTO DOOR)" "$log" || true
if grep -qE "SCRIPT ERROR|Parse Error" "$log"; then grep -E -A2 "SCRIPT ERROR|Parse Error" "$log" | head -20; echo "renderer script errors"; exit 1; fi
walks=$(grep -c "^WALK" "$log" || true)
bad=$(grep -cE "^(NO WAY IN|AUTO DOOR)" "$log" || true)
echo "rooms walkable: $walks, problems: $bad"
[ "$walks" -gt 0 ] && [ "$bad" -eq 0 ]
