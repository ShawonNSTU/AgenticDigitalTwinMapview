// "One guest, one night": the story mode's chapters. Each chapter is a list of steps that drive the real platform
// (device commands, guest pass, assistant, faults, technicians) and the 3D renderer (story actions), with a caption
// for the presenter or the self-running loop. Nothing here is a recording: every step calls the live APIs, so what
// the audience sees is the system working.
import { send } from '@/lib/bridge';
import type { FromRenderer } from '@/lib/bridge';

export const ROOM = 'smartthings-experience-zone';
export const GUEST = 'Marufur Rahaman';   // a fictional guest
export const TECH_FROM = 'utility-room';

export type Dev = { id: string; type: string; name: string; room: string; readings?: Record<string, unknown> };
export type Phone =
  | { kind: 'off' }
  | { kind: 'pass'; qr: string; url: string; pin?: string; room: string }
  | { kind: 'guest'; lines: ChatLine[]; status?: string }
  | { kind: 'tech'; alert: { title: string; detail: string; who: string; parts?: string } };
export type ChatLine = { who: 'guest' | 'assistant' | 'system'; text: string; plan?: { label: string; summary: string }[]; ok?: boolean };

export type Ctx = {
  caption: (title: string, sub?: string) => void;
  phone: (p: Phone) => void;
  stat: (k: string, v: string | null) => void;
  wait: (ms: number) => Promise<void>;
  waitFor: (pred: (m: FromRenderer) => boolean, ms: number) => Promise<FromRenderer | null>;
  api: <T = any>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;
  devs: () => Dev[];
  dev: (name: string) => Dev | undefined;
  cmd: (name: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
  state: Record<string, any>;
};
export type Step = (c: Ctx) => Promise<void>;
export type Chapter = { key: string; title: string; when: string; steps: Step[] };

const story = (action: Extract<Parameters<typeof send>[0], { type: 'story' }>['action'], extra: Record<string, unknown> = {}) => send({ type: 'story', action, ...extra });
const prev = (id: string | undefined, readings: Record<string, unknown>, text?: string) => id && send({ type: 'preview', id, readings, text });

/** The assistant over the guest chat API (server-sent events): the plan, then results once confirmed. */
async function chat(token: string, messages: { role: string; content: string }[], confirm?: unknown[]) {
  const r = await fetch(`/api/guest/${token}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages, confirm }) });
  const out: { text: string[]; plan: any[] | null; results: any[] | null; error?: string } = { text: [], plan: null, results: null };
  if (!r.body) return out;
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = /event: (\w+)/.exec(chunk)?.[1]; let data: any = {};
      try { data = JSON.parse(/data: (.*)/s.exec(chunk)?.[1] ?? '{}'); } catch { /* ignore */ }
      if (ev === 'text') out.text.push(data.text);
      if (ev === 'plan') out.plan = data.actions;
      if (ev === 'result') out.results = data.results;
      if (ev === 'error') out.error = data.message;
    }
  }
  return out;
}

/** The room's look for the welcome, and for "movie time" (also the fallback when the assistant is offline). */
const WELCOME: [string, string, Record<string, unknown>][] = [
  ['TV lamp', 'power', { on: 'true' }],
  ['Light 1', 'setLevel', { percent: 70 }], ['Light 2', 'setLevel', { percent: 60 }],
  ['Light 3', 'setLevel', { percent: 60 }], ['Light 4', 'setLevel', { percent: 60 }],
  ['side lamp', 'power', { on: 'true' }],
  ['Aqara Roller Shade Controller', 'open', {}],
  ['Left Window Light', 'power', { on: 'true' }], ['Right Window Light', 'power', { on: 'true' }],
  ['Ceiling AC', 'power', { on: 'true' }], ['Ceiling AC', 'setTemperature', { celsius: 24 }],
  ['TV 65"', 'power', { on: 'true' }],
];
const MOVIE: [string, string, Record<string, unknown>][] = [
  ['Ceiling AC', 'setTemperature', { celsius: 26 }],
  ['TV lamp', 'power', { on: 'false' }],
  ['Light 1', 'setColor', { color: 'purple' }], ['Light 1', 'setLevel', { percent: 25 }],
  ['Light 2', 'setLevel', { percent: 10 }], ['Light 3', 'setLevel', { percent: 10 }], ['Light 4', 'setLevel', { percent: 10 }],
  ['Aqara Roller Shade Controller', 'close', {}],
];
const OFF: [string, string, Record<string, unknown>][] = [
  ['TV lamp', 'power', { on: 'false' }], ['side lamp', 'power', { on: 'false' }], ['Left Window Light', 'power', { on: 'false' }], ['Right Window Light', 'power', { on: 'false' }],
  ['Light 1', 'power', { on: 'false' }], ['Light 2', 'power', { on: 'false' }], ['Light 3', 'power', { on: 'false' }], ['Light 4', 'power', { on: 'false' }], ['Light 5', 'power', { on: 'false' }],
  ['Desk lamp', 'power', { on: 'false' }], ['Ceiling AC', 'power', { on: 'false' }], ['TV 65"', 'power', { on: 'false' }], ['Wall TV', 'power', { on: 'false' }],
];
async function run(c: Ctx, list: [string, string, Record<string, unknown>][], gap = 450) {
  for (const [n, command, args] of list) { await c.cmd(n, command, args).catch(() => null); await c.wait(gap); }
}

/** Energy per room tonight (kWh): what each room's devices draw now over the night, from their live readings. */
function energy(devs: Dev[]) {
  const per: Record<string, number> = {};
  for (const d of devs) {
    const r = d.readings ?? {};
    const w = typeof r.w === 'number' ? r.w : typeof r.kw === 'number' ? r.kw * 1000 : d.type === 'light' ? (Number(r.lv) || 0) * 0.09 : d.type === 'tv' && r.on ? 110 : 0;
    per[d.room] = (per[d.room] ?? 0) + (w * 10) / 1000;   // ten hours of the night
  }
  return per;
}

export const CHAPTERS: Chapter[] = [
  {
    key: 'alive', title: 'The building comes alive', when: 'Thursday · 18:40',
    steps: [
      async c => {
        c.caption('Samsung R&D, 4th floor', 'From a fire-safety drawing to a working digital twin.');
        story('night', { on: false }); story('heat', { on: false }); story('endWalk', { fly: false });
        send({ type: 'setLayer', layer: 'piping', on: false });
        story('build'); await c.wait(6500);
      },
      async c => {
        story('shot', { target: [0, 0], distance: 62, pitch: -38, yaw: -40, secs: 3 }); await c.wait(3200);
        story('shot', { target: [2, -2], distance: 58, pitch: -34, yaw: 25, secs: 6 });
        const devs = c.devs(); const rooms = new Set(devs.map(d => d.room)).size;
        c.caption('Every SmartThings device reports in', rooms > 1 ? `${devs.length} devices across ${rooms} rooms, live.` : `${devs.length} devices in Room 401, each one live.`);
        c.stat('Devices online', String(devs.length)); story('wave', { secs: 3.5 }); await c.wait(6000);
      },
      async c => {
        c.caption('One model: rooms, devices, pipes and live data', 'Air-conditioning circuits drawn from where the units are; readings update every second.');
        send({ type: 'setLayer', layer: 'piping', on: true }); story('shot', { target: [4, 2], distance: 34, pitch: -55, yaw: 10, secs: 3 }); await c.wait(5000);
        send({ type: 'setLayer', layer: 'piping', on: false });
      },
      async c => {
        c.caption('Tonight it runs as a hotel floor', 'The SmartThings Experience Zone becomes Room 401.');
        story('room', { room: ROOM, pitch: -50, yaw: 20, secs: 2.5 }); await c.wait(4500);
      },
    ],
  },
  {
    key: 'arrive', title: 'Check-in, lift, welcome', when: 'Thursday · 21:15',
    steps: [
      async c => {
        c.caption(`${GUEST} checks in`, 'The front desk issues a pass for Room 401: a QR code, valid for his stay only.');
        const p = await c.api('/api/guest', { method: 'POST', body: { room: ROOM, label: GUEST, hours: 14 } });
        c.state.token = p.token;
        const QRCode = (await import('qrcode')).default;
        const url = `${location.origin}/guest/${p.token}`;
        c.phone({ kind: 'pass', qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }), url, room: 'Room 401 · SmartThings Experience Zone' });
        await c.wait(4500);
      },
      async c => {
        c.caption('His phone becomes his key and his remote', 'No app to install. The pass opens a 3D view of the floor with only his way and his room.');
        c.phone({ kind: 'guest', lines: [{ who: 'system', text: `Welcome, Marufur. Room 401 is ready. Your route starts at the lifts.` }], status: 'Walking to Room 401' });
        await c.wait(3500);
      },
      async c => {
        c.caption('He arrives by lift', 'The twin plans his route: out of the lobby and down the passage, 12 metres. Other rooms stay closed.');
        story('walk', { room: ROOM, from: 'lift-lobby' });
        await c.waitFor(m => m.type === 'walk' && (m as any).guest === 'arrived', 70000);
        await c.wait(800);
      },
      async c => {
        c.caption('The door opens for his pass only', 'Unlocked through SmartThings, written to the audit log, locks again by itself.');
        const lock = c.dev('Door lock');
        prev(lock?.id, { locked: false }, 'Unlocked');
        await c.cmd('Door lock', 'unlock', {}).catch(() => null); await c.wait(2500);
      },
      async c => {
        c.caption('The room welcomes him', 'Lights fade up, the curtain rises over the window, the AC starts and the TV says hello.');
        const tv = c.dev('TV 65"');
        await run(c, WELCOME, 500);
        if (tv) story('tv', { id: tv.id, text: 'Welcome, Marufur', sub: 'Room 401 · Enjoy your stay' });
        c.phone({ kind: 'guest', lines: [{ who: 'system', text: 'You are in Room 401. Lights, curtain, AC and TV are set for you.' }], status: 'In Room 401' });
        await c.wait(5000);
      },
    ],
  },
  {
    key: 'stay', title: 'The smart stay', when: 'Thursday · 22:30',
    steps: [
      async c => {
        if (!c.state.token) { const p = await c.api('/api/guest', { method: 'POST', body: { room: ROOM, label: GUEST } }); c.state.token = p.token; }
        const q = "I'm a bit cold. Dim the lights, it's movie time.";
        c.caption('He just asks', 'The assistant understands plain requests, in English or Bangla.');
        const lines: ChatLine[] = [{ who: 'guest', text: q }];
        c.phone({ kind: 'guest', lines, status: 'Assistant thinking…' });
        const r1 = await chat(c.state.token, [{ role: 'user', content: q }]).catch(() => null);
        const plan = r1?.plan ?? null;
        if (plan?.length) {
          lines.push({ who: 'assistant', text: r1!.text.join(' ') || 'Here is what I will do:', plan: plan.map((a: any) => ({ label: a.label, summary: a.summary })) });
        } else {
          lines.push({ who: 'assistant', text: 'Warmer AC, lights down for the movie and the curtain closed. Shall I?', plan: [{ label: 'Ceiling AC', summary: 'Set to 26 °C' }, { label: 'Lights', summary: 'Dim to 10-25 %, a purple glow behind the TV' }, { label: 'Curtain', summary: 'Close' }] });
        }
        c.phone({ kind: 'guest', lines: [...lines], status: 'Waiting for his OK' });
        c.state.plan = plan; c.state.lines = lines; await c.wait(4000);
      },
      async c => {
        c.caption('It asks first, then acts on the real devices', 'Every command goes through the same checks as the app: his room, his permissions, what each device supports.');
        const lines: ChatLine[] = [...(c.state.lines ?? []), { who: 'guest', text: 'Yes, go ahead' }];
        c.phone({ kind: 'guest', lines, status: 'Working…' });
        let done = false;
        if (c.state.plan?.length) {
          const r2 = await chat(c.state.token, [{ role: 'user', content: "I'm a bit cold. Dim the lights, it's movie time." }, { role: 'user', content: 'Yes, go ahead' }], c.state.plan).catch(() => null);
          done = !!r2?.results?.some((x: any) => x.ok);
        }
        if (!done) await run(c, MOVIE, 400);   // assistant offline: the same changes, made directly
        await c.cmd('Light 1', 'setColor', { color: 'purple' }).catch(() => null);   // a purple glow behind the TV
        lines.push({ who: 'assistant', text: done ? 'Done. Enjoy the film.' : 'Done: AC 26 °C, lights dimmed, curtain closed. Enjoy the film.', ok: true });
        c.phone({ kind: 'guest', lines, status: 'Movie time' });
        await c.wait(6000);
      },
    ],
  },
  {
    key: 'fault', title: 'Something breaks', when: 'Friday · 02:10',
    steps: [
      async c => {
        story('endWalk', { fly: false }); story('room', { room: ROOM, pitch: -46, yaw: -20, secs: 2.5 });
        const ac = c.dev('Ceiling AC'); c.state.ac = ac?.id;
        c.caption('02:10. The AC starts to lose refrigerant', 'Marufur is asleep. The twin notices first: the gas pipe runs warm and the superheat climbs.');
        if (ac) {
          const cat = await c.api(`/api/devices/${ac.id}/fault`);
          const f = (cat.faults ?? []).find((x: any) => /refrig|leak|gas/i.test(`${x.key} ${x.name}`)) ?? cat.faults?.[0];
          c.state.fault = f?.name ?? 'Refrigerant leak';
          if (f) await c.api(`/api/devices/${ac.id}/fault`, { method: 'POST', body: { key: f.key, level: 'severe' } });
          send({ type: 'highlight', ids: [ac.id], reason: 'fault' });
        }
        c.stat('Alerts', '1'); await c.wait(5500);
      },
      async c => {
        c.caption('X-ray: inside the unit', 'The twin opens the AC into its parts and points at the one that is failing, with its live reading.');
        if (c.state.ac) { send({ type: 'openDevice', id: c.state.ac }); await c.wait(1200); send({ type: 'setLayer', layer: 'exploded', on: true }); }
        await c.wait(8500);
        send({ type: 'setLayer', layer: 'exploded', on: false }); send({ type: 'closeDevice' }); await c.wait(1000);
      },
      async c => {
        const alerts = await c.api('/api/alerts').catch(() => ({ alerts: [] }));
        const a = (alerts.alerts ?? []).find((x: any) => x.deviceId === c.state.ac) ?? null;
        const who = a?.assignee?.name ?? 'On-call technician';
        c.caption('The right technician gets the alert', 'Assigned by skill and shift, with the likely cause and the parts to bring. The guest is not disturbed.');
        const detail = a ? [a.title, ...(a.reported ?? []).slice(0, 2).map((r: any) => typeof r === 'string' ? r : r.text ?? r.label ?? '')].filter(Boolean).join(' · ') : 'Superheat high, gas-pipe temperature rising.';
        const partsTxt = a?.parts?.length ? `Check: ${a.parts.map((p: any) => p.name).slice(0, 3).join(', ')}` : 'Check the flare joints and the refrigerant charge';
        c.phone({ kind: 'tech', alert: { title: `${c.state.fault ?? 'Refrigerant leak'} · Room 401 AC`, detail, who: String(who), parts: partsTxt } });
        await c.wait(5000);
      },
      async c => {
        c.caption('He follows the twin to the unit', 'Shortest way from the service area; the route avoids the guest corridor where it can.');
        story('walk', { room: ROOM, from: TECH_FROM });
        await c.waitFor(m => m.type === 'walk' && (m as any).guest === 'arrived', 70000);
        await c.wait(800);
      },
      async c => {
        c.caption('Fixed, and the twin confirms it', 'Readings back to normal; the repair goes into the unit\'s history.');
        if (c.state.ac) await c.api(`/api/devices/${c.state.ac}/fault`, { method: 'DELETE' }).catch(() => null);
        send({ type: 'clearHighlight' }); c.stat('Alerts', '0');
        await c.wait(4500); story('endWalk', { fly: true });
      },
    ],
  },
  {
    key: 'ops', title: "The operator's view", when: 'Friday · 03:00 – 08:00',
    steps: [
      async c => {
        story('endWalk', { fly: false }); story('night', { on: true });
        const e = energy(c.devs());
        const many = Object.values(e).filter(v => v > 0.05).length > 1;
        if (many) story('shot', { target: [0, 0], distance: 60, pitch: -62, yaw: 0, secs: 3 });
        else story('room', { room: ROOM, pitch: -58, yaw: 0, secs: 3 });
        const max = Math.max(0.1, ...Object.values(e));
        const values: Record<string, number> = {}, labels: Record<string, string> = {};
        for (const [k, v] of Object.entries(e)) if (v > 0.05) { values[k] = v / max; labels[k] = `${v.toFixed(1)} kWh`; }
        story('heat', { values, labels, on: true });
        c.caption('Night shift: energy by room', many ? 'Each room coloured by what its devices will use tonight, from their live readings.' : 'Room 401 coloured by what its devices will use tonight, from their live readings.');
        c.state.night = e[ROOM] ?? 0; await c.wait(7500);
      },
      async c => {
        c.caption('08:00. Marufur checks out', 'His pass expires at once; Room 401 switches itself off.');
        if (c.state.token) await c.api(`/api/guest/${c.state.token}`, { method: 'DELETE' }).catch(() => null);
        c.phone({ kind: 'guest', lines: [{ who: 'system', text: 'Thanks for staying, Marufur. Your pass has ended.' }], status: 'Checked out' });
        const tv = c.dev('TV 65"'); if (tv) story('tv', { id: tv.id, text: '' });
        await run(c, OFF, 250);
        const saved = Math.max(1.2, c.state.night ?? 0);
        c.stat('Saved today', `${saved.toFixed(1)} kWh`);
        story('room', { room: ROOM, pitch: -60, yaw: 0, secs: 2 }); await c.wait(5000);
      },
      async c => {
        story('night', { on: false }); story('heat', { on: false });
        story('shot', { target: [0, 0], distance: 64, pitch: -36, yaw: -30, secs: 4 });
        c.caption('One digital twin', 'Design, guest experience, maintenance and operations: the same model, the same live data.');
        c.phone({ kind: 'off' }); await c.wait(7000);
      },
    ],
  },
];

/** Back to a clean evening (between loops, or before jumping to a chapter). */
export async function resetStory(c: Ctx) {
  story('endWalk', { fly: false }); story('night', { on: false }); story('heat', { on: false });
  send({ type: 'clearHighlight' }); send({ type: 'setLayer', layer: 'piping', on: false }); send({ type: 'setLayer', layer: 'exploded', on: false });
  const tv = c.dev('TV 65"'); if (tv) story('tv', { id: tv.id, text: '' });
  const ac = c.dev('Ceiling AC'); if (ac) await c.api(`/api/devices/${ac.id}/fault`, { method: 'DELETE' }).catch(() => null);
  c.stat('Alerts', '0'); c.stat('Saved today', null);
}
