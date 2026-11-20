'use client';
import { useRef, useState } from 'react';

export type Cmd = { name: string; args: Record<string, [number, number] | string[]>; confirm?: boolean; needsConfirmation?: boolean };
type State = { readings: Record<string, unknown>; overrides?: Record<string, unknown> | null };
export type Run = (command: string, args?: Record<string, unknown>, confirmed?: boolean) => void;

// reading that shows a command's current value
const VALUE_KEY: Record<string, string> = { power: 'on', setTemperature: 'set', setFanSpeed: 'fan', setLevel: 'lv', setPosition: 'pos', setFan: 'fan', setMode: 'mode', setSwing: 'swing', setTimer: 'timer', setVolume: 'vol', setInput: 'input', setSpeed: 'speed', setOscillation: 'osc', setColorTemperature: 'ct' };
export const CMD_LABEL: Record<string, string> = {
  power: 'Power', setTemperature: 'Temperature', setMode: 'Mode', setFanSpeed: 'Fan speed', setSwing: 'Louver', setTimer: 'Off timer',
  setLevel: 'Brightness', setColorTemperature: 'Light colour', setPosition: 'Open', open: 'Open', close: 'Close', setFan: 'Fan level',
  setVolume: 'Volume', setInput: 'Source', setSpeed: 'Speed', setOscillation: 'Oscillate', lock: 'Lock the door', unlock: 'Unlock the door',
  start: 'Start cleaning', dock: 'Send to dock', stop: 'Stop',
};
// controls shown first; others follow in the device's order
const ORDER = ['power', 'setMode', 'setTemperature', 'setFanSpeed', 'setSwing', 'setTimer', 'setLevel', 'setColorTemperature', 'open', 'close', 'setPosition', 'setSpeed', 'setOscillation', 'setFan', 'setVolume', 'setInput'];

/** Controls for a device, built from the commands it supports (never assuming every option exists).
 *  A power switch that is off hides the other controls; commands that need confirmation ask first. */
export default function DeviceControls({ dev, commands, run, disabled }: { dev: State & { type: string }; commands: Cmd[]; run: Run; disabled?: boolean }) {
  const rank = (n: string) => { const i = ORDER.indexOf(n); return i < 0 ? 999 : i; };
  const sorted = [...commands].sort((a, b) => rank(a.name) - rank(b.name));
  const power = commands.find(c => c.name === 'power');
  const val = (k: string) => dev.overrides?.[k] ?? dev.readings[k];
  const off = power && dev.type !== 'light' ? !(val('on') === true || val('on') === 'true') : false;
  return (
    <div className={`ctrls ${disabled ? 'disabled' : ''}`}>
      {sorted.filter(c => !off || c.name === 'power').map(c => <Control key={c.name} cmd={c} cur={VALUE_KEY[c.name] ? val(VALUE_KEY[c.name]) : undefined} run={run} />)}
    </div>
  );
}

function Control({ cmd, cur, run }: { cmd: Cmd; cur: unknown; run: Run }) {
  const [arg, rule] = Object.entries(cmd.args)[0] ?? [];
  const [draft, setDraft] = useState<number | null>(null);
  const [ask, setAsk] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const label = CMD_LABEL[cmd.name] ?? cmd.name;
  const confirm = cmd.confirm || cmd.needsConfirmation;
  if (!arg) {
    if (confirm) return ask
      ? <div className="ctrl-row confirm"><span>{label}?</span><div className="row"><button className="pri" onClick={() => { setAsk(false); run(cmd.name, {}, true); }}>Yes</button><button onClick={() => setAsk(false)}>No</button></div></div>
      : <button className="ctrl-btn" onClick={() => setAsk(true)}>{label}</button>;
    return <button className="ctrl-btn" onClick={() => run(cmd.name)}>{label}</button>;
  }
  if (Array.isArray(rule) && typeof rule[0] === 'string') {
    const opts = rule as string[];
    if (opts.length === 2 && opts.includes('true')) {
      const on = cur === true || cur === 'true';
      return (
        <div className="ctrl-row"><span>{label}</span>
          <button className={`tgl ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={label} onClick={() => run(cmd.name, { [arg]: on ? 'false' : 'true' })}><i /></button>
        </div>
      );
    }
    return (
      <div className="ctrl-row col"><span>{label}</span>
        <div className="seg wrap">{opts.map(o => <button key={o} className={String(cur) === o ? 'on' : ''} onClick={() => run(cmd.name, { [arg]: o })}>{o[0].toUpperCase() + o.slice(1)}</button>)}</div>
      </div>
    );
  }
  const [lo, hi] = rule as [number, number];
  const v = draft ?? (typeof cur === 'number' ? cur : Number(cur ?? lo));
  if (cmd.name === 'setTemperature') return (
    <div className="ctrl-row"><span>{label}</span>
      <div className="stepper">
        <button aria-label="Cooler" onClick={() => run(cmd.name, { [arg]: Math.max(lo, Math.round(v) - 1) })}>−</button>
        <b>{Math.round(v)} °C</b>
        <button aria-label="Warmer" onClick={() => run(cmd.name, { [arg]: Math.min(hi, Math.round(v) + 1) })}>+</button>
      </div>
    </div>
  );
  if (hi - lo <= 5 && cmd.name !== 'setTimer') return (
    <div className="ctrl-row"><span>{label}</span>
      <div className="seg">{Array.from({ length: hi - lo + 1 }, (_, i) => lo + i).map(x => <button key={x} className={Math.round(v) === x ? 'on' : ''} onClick={() => run(cmd.name, { [arg]: x })}>{x}</button>)}</div>
    </div>
  );
  const unit = cmd.name === 'setColorTemperature' ? ' K' : cmd.name === 'setTimer' ? ' h' : '%';
  const shown = cmd.name === 'setColorTemperature' ? (v < 3500 ? 'Warm' : v < 5000 ? 'Neutral' : 'Daylight') : `${Math.round(v)}${unit}`;
  return (
    <label className="ctrl-row slider"><span>{label} <b>{cmd.name === 'setTimer' && Math.round(v) === 0 ? 'Off' : shown}</b></span>
      <input type="range" min={lo} max={hi} step={cmd.name === 'setColorTemperature' ? 100 : 1} value={Math.round(v)} onChange={e => {
        const x = +e.target.value; setDraft(x);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => { run(cmd.name, { [arg]: x }); setTimeout(() => setDraft(null), 1500); }, 350);
      }} />
    </label>
  );
}
