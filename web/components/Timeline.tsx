'use client';
type Sim = { t: number; playing: boolean; scenario: string; scenarios: { key: string; name: string; available?: boolean }[] };
const post = (b: object) => fetch('/api/sim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
const hh = (t: number) => `${String(Math.floor(t)).padStart(2, '0')}:${String(Math.floor((t % 1) * 60)).padStart(2, '0')}`;

/** Scenario picker and day timeline. The simulated platform owns the clock. */
export default function Timeline({ sim }: { sim: Sim | null }) {
  if (!sim) return null;
  return (
    <div className="timeline row">
      <button className="pri" onClick={() => post({ playing: !sim.playing })}>{sim.playing ? 'Pause' : 'Play'}</button>
      <input type="range" min={6} max={22} step={0.05} value={sim.t} onChange={e => post({ t: +e.target.value })} />
      <b>{hh(sim.t)}</b>
      <select value={sim.scenario} onChange={e => post({ scenario: e.target.value })}>{sim.scenarios.map(s => <option key={s.key} value={s.key} disabled={s.available === false}>{s.name}{s.available === false ? ' (no matching device on this floor)' : ''}</option>)}</select>
    </div>
  );
}
