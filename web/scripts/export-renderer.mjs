// Exports the Godot renderer for the web into web/public/godot (Windows, macOS, Linux).
// Uses the GODOT environment variable if set (full path to the Godot 4.7 editor), else `godot` on the PATH.
// Needs Godot's export templates installed (Editor > Manage Export Templates).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = path.resolve(web, '..', 'godot-renderer');
const godot = process.env.GODOT || 'godot';
mkdirSync(path.join(web, 'public', 'godot'), { recursive: true });
console.log(`Exporting ${project} with ${godot} ...`);
const r = spawnSync(godot, ['--headless', '--path', project, '--export-release', 'Web'], { stdio: 'inherit', shell: process.platform === 'win32' });
const out = path.join(web, 'public', 'godot', 'index.html');
if (r.error || r.status !== 0 || !existsSync(out)) {
  console.error(`\nExport failed. Set GODOT to the Godot 4.7 editor, e.g.\n  PowerShell:  $env:GODOT="C:\\Tools\\Godot_v4.7.2-stable_win64.exe"; npm run export:renderer\n  bash:        GODOT=/path/to/godot npm run export:renderer\nand install the export templates (Editor > Manage Export Templates).`);
  process.exit(1);
}
console.log(`Done: ${out} (${new Date(statSync(out).mtime).toLocaleString()}). Restart the web server.`);
