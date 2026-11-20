// Fault simulation checks: every fault of every device type, at every severity.
// Run: npm run test:faults   (exits 1 on any problem)
import { DEV, TYPES, setDevices, setFault, clearFault, snapshot, faultCatalog } from '../lib/sim/engine';
import { FAULTS } from '../lib/sim/faults';
// one device of every type
setDevices(Object.keys(TYPES).map((type, i) => ({ id: `${type}-1`, type, room: 'living', name: type, position: [i, 0, 0] })));
const realNow = Date.now; let problems = 0, total = 0;
for (const type of Object.keys(TYPES)) {
  const keys = new Set(TYPES[type].parts.map((p: any) => p.key));
  for (const f of FAULTS[type] ?? []) {
    for (const p of [...Object.keys(f.parts), ...f.steps.map(s => s.p)]) if (!keys.has(p)) { problems++; console.log('MISSING PART', type, f.key, p); }
    for (const level of ['early', 'developing', 'severe']) {
      total++;
      Date.now = realNow; setFault(`${type}-1`, f.key, level);
      Date.now = () => realNow() + 7000; // fully developed
      let s: any;
      try { s = snapshot(`${type}-1`, 10); } catch (e) { problems++; console.log('THROW', type, f.key, level, (e as Error).message); continue; }
      const bad = s.parts.filter((p: any) => p.health !== 'ok').map((p: any) => `${p.key}:${p.health}`);
      if (level === 'severe' && process.env.VERBOSE) console.log(`${type.padEnd(8)} ${f.key.padEnd(12)} health=${s.health.padEnd(5)} parts=[${bad.join(' ')}] finding="${s.finding?.title}" ev="${s.finding?.ev?.[0]}"`);
      if (level === 'severe' && s.health === 'ok') { problems++; console.log('  -> severe fault leaves device healthy'); }
      if (s.finding && s.finding.ev.some((e: string) => /NaN|undefined/.test(e))) { problems++; console.log('  -> bad evidence', s.finding.ev); }
      if (s.parts.some((p: any) => /NaN|undefined/.test(p.value))) { problems++; console.log('  -> bad part value', type, f.key, s.parts.filter((p: any) => /NaN|undefined/.test(p.value)).map((p: any) => p.key + '=' + p.value)); }
    }
    Date.now = realNow; clearFault(`${type}-1`);
    if (snapshot(`${type}-1`, 10).finding?.simulated) { problems++; console.log('fault not cleared'); }
  }
  if (!faultCatalog(type).length) console.log('NO FAULTS for', type);
}
// ramp: right after setting, severity is near zero
setFault('ac-1', 'filter', 'severe'); const s0 = snapshot('ac-1', 10);
if (!(s0.fault.severity < 0.1 && s0.fault.developing)) { problems++; console.log('fault should start near zero and develop'); }
console.log(`checked ${total} fault/level combinations, problems: ${problems}`);
if (problems) process.exit(1);
