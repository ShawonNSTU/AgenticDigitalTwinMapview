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
  | { kind: 'guest'; lines: ChatLine[]; status?: string; title?: string }
  | { kind: 'tech'; alert: { title: string; detail: string; who: string; parts?: string }; lines?: ChatLine[] };
export type ChatLine = { who: 'guest' | 'assistant' | 'system'; text: string; plan?: { label: string; summary: string; ok?: boolean }[]; ok?: boolean; thinking?: string };

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

/** One turn of the assistant (the same agent the app uses: /api/chat for staff, /api/guest/{pass}/chat for the guest),
 *  read from its event stream. `live` is called as it thinks and works, so the phone shows the reasoning and the
 *  current step while it happens. */
export type AgentReply = { text: string; reasoning: string; step: string; results: { id?: string; label: string; ok: boolean; summary?: string; error?: string }[]; actions: any[]; card: any; offer: boolean; error?: string };
const empty = (error?: string): AgentReply => ({ text: '', reasoning: '', step: '', results: [], actions: [], card: null, offer: false, error });
export async function agent(url: string, messages: { role: string; content: string }[], live?: (r: AgentReply) => void): Promise<AgentReply> {
  const out = empty();
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages }) });
  if (!r.body) { out.error = `HTTP ${r.status}`; return out; }
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
      if (ev === 'text') out.text = out.text ? `${out.text}\n${data.text}` : String(data.text);
      else if (ev === 'reasoning') out.reasoning += String(data.text ?? '');
      else if (ev === 'step') out.step = String(data.text ?? '');
      else if (ev === 'result') out.results = (data.results ?? []).map((x: any) => ({ id: x.device_id, label: x.label, ok: !!x.ok, summary: x.summary, error: x.error }));
      else if (ev === 'ui_action') out.actions.push(data);
      else if (ev === 'card') out.card = data;
      else if (ev === 'offer') out.offer = true;
      else if (ev === 'error') out.error = String(data.message ?? 'failed');
      if (ev && ev !== 'done') live?.({ ...out });
    }
  }
  return out;
}
/** A colour name from a SmartThings hue (0-100). */
function hueName(hue: number, sat = 100) {
  if (sat < 15) return 'white';
  const d = (((hue * 3.6) % 360) + 360) % 360;
  return d < 15 || d >= 345 ? 'red' : d < 45 ? 'orange' : d < 70 ? 'yellow' : d < 160 ? 'green' : d < 200 ? 'cyan' : d < 255 ? 'blue' : d < 290 ? 'purple' : 'pink';
}
/** What a device change means, in words, from the SmartThings commands the assistant sent ("setLevel 25 · setColor {…}"). */
export function humanize(summary: string | undefined): string {
  if (!summary || summary === 'done') return 'done';
  const parts = summary.split(' · ').map(s => {
    const [cmd, ...rest] = s.trim().split(' '); const a = rest.join(' ');
    switch (cmd) {
      case 'on': return 'on';
      case 'off': return 'off';
      case 'open': return 'open';
      case 'close': return 'closed';
      case 'pause': return 'stopped';
      case 'lock': return 'locked';
      case 'unlock': return 'unlocked';
      case 'setLevel': return Number(a) === 0 ? 'off' : `${a} %`;
      case 'setShadeLevel': return Number(a) >= 100 ? 'fully open' : Number(a) <= 0 ? 'closed' : `${a} % open`;
      case 'setColorTemperature': return Number(a) <= 3000 ? 'warm white' : Number(a) >= 5000 ? 'cool white' : 'neutral white';
      case 'setColor': { try { const j = JSON.parse(a); return hueName(Number(j.hue), Number(j.saturation ?? 100)); } catch { return 'colour'; } }
      case 'setHue': return hueName(Number(a));
      case 'setCoolingSetpoint': case 'setHeatingSetpoint': return `${a} °C`;
      case 'setAirConditionerMode': return a === 'fanOnly' ? 'fan only' : a;
      case 'setVolume': return `volume ${a}`;
      case 'mute': return 'muted';
      case 'setInputSource': return a;
      default: return `${cmd.replace(/^set/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}${a ? ` ${a}` : ''}`;
    }
  });
  // "on" says nothing next to a level or a temperature
  const out = parts.length > 1 ? parts.filter(p => p !== 'on') : parts;
  return [...new Set(out)].join(', ');
}
/** A device's name for a guest: the roller shade is "Curtain". */
const friendly = (label: string) => /roller shade|shade controller|blind/i.test(label) ? 'Curtain' : label;
/** One checklist item per device, then devices with the same change on one line ("Light 2, 3, 4 · 10 %"). */
export function checklist(items: { label: string; summary: string; ok: boolean }[]) {
  const by = new Map<string, { label: string; summary: string; ok: boolean }>();
  for (const x of items) {
    const k = friendly(x.label), p = by.get(k);
    by.set(k, { label: k, summary: p ? `${p.summary}, ${x.summary}` : x.summary, ok: x.ok && (p?.ok ?? true) });
  }
  const out: { label: string; summary: string; ok: boolean }[] = [];
  for (const x of by.values()) {
    const same = out.find(o => o.ok === x.ok && o.summary === x.summary && o.label.split(/,? /)[0] === x.label.split(' ')[0] && /\d$/.test(x.label));
    if (same) same.label += `, ${x.label.split(' ').pop()}`;
    else out.push({ ...x });
  }
  return out;
}
/** The device changes of a reply as checklist items. */
function changes(r: AgentReply) {
  return checklist(r.results.map(x => ({ label: x.label, ok: x.ok,
    summary: x.ok ? humanize(x.summary) : `didn't respond${x.error ? ` (${x.error.replace(/^SmartThings:\s*/, '').slice(0, 60)})` : ''}` })));
}
/** The assistant's answer for the phone: its own words, formatted, and the checklist of what it changed. */
const said = (r: AgentReply, fallback: string): ChatLine => {
  const plan = changes(r);
  return { who: 'assistant', text: (r.text || fallback).trim(), plan: plan.length ? plan : undefined, ok: plan.length ? plan.some(x => x.ok) : undefined };
};
/** The assistant is offline: the story runs the same change itself and says so in the same way. */
async function act(c: Ctx, list: [string, string, Record<string, unknown>][], text: string): Promise<ChatLine> {
  const done = await run(c, list, 450);
  return { who: 'assistant', text, plan: checklist(done), ok: done.some(x => x.ok) };
}
/** A short, whole sentence of what the assistant is thinking now (its reasoning streams in fragments). */
function thought(p: AgentReply) {
  const t = p.reasoning.replace(/\s+/g, ' ').trim();
  if (!t) return `${p.step || 'Thinking'}…`;
  const s = t.split(/(?<=[.!?])\s+/).filter(x => x.length > 12);
  const last = (s.length > 1 && !/[.!?]$/.test(s[s.length - 1]) ? s[s.length - 2] : s[s.length - 1]) ?? t;
  return last.length > 150 ? `${last.slice(0, 147).replace(/\s\S*$/, '')}…` : last;
}
/** Ask the assistant and show it on the phone while it works. */
async function converse(c: Ctx, url: string, lines: ChatLine[], q: string, extra: { title?: string; status?: string; history?: { role: string; content: string }[] } = {}) {
  lines.push({ who: 'guest', text: q });
  const show = (thinking: string) => c.phone({ kind: 'guest', title: extra.title, lines: [...lines, { who: 'assistant', text: '', thinking }], status: extra.status ?? 'Assistant thinking…' });
  show('Thinking…');
  return agent(url, [...(extra.history ?? []), { role: 'user', content: q }], p => show(thought(p))).catch(e => empty(String(e)));
}
/** The assistant answered (it is online), as opposed to the stream failing. */
const answered = (r: AgentReply) => !r.error && (!!r.text.trim() || r.results.length > 0);

/** Point at devices that just changed: in the guest's first-person view he turns to the most visible one (curtain,
 *  windows, lights, TV) and they all glow; from above they glow. */
function spot(c: Ctx, ids: string[]) {
  if (!ids.length) return;
  if (c.state.inRoom) {
    const rank = (id: string) => ['blinds', 'light', 'tv', 'ac'].indexOf(c.devs().find(d => d.id === id)?.type ?? '') + 1 || 9;
    send({ type: 'walk', action: 'look', id: [...ids].sort((a, b) => rank(a) - rank(b))[0] });
    setTimeout(() => send({ type: 'highlight', ids, reason: 'changed by the assistant' }), 300);
  } else send({ type: 'highlight', ids, reason: 'changed by the assistant' });
}
const idsOf = (c: Ctx, list: [string, string, Record<string, unknown>][]) => [...new Set(list.map(([n]) => c.dev(n)?.id).filter(Boolean) as string[])];

/** Show in 3D what the assistant just did, so the room matches what the phone says: the devices it changed, or
 *  (from above) its own view actions: highlight, open a unit, focus a part. */
function reflect(c: Ctx, r: AgentReply) {
  const ids = [...new Set(r.results.filter(x => x.ok && x.id).map(x => x.id as string))];
  if (ids.length) { spot(c, ids); return; }
  if (c.state.inRoom) return;
  for (const a of r.actions) {
    if (a.type === 'highlight' && Array.isArray(a.ids)) send({ type: 'highlight', ids: a.ids, reason: a.reason });
    else if (a.type === 'focusDevice' && a.id) send({ type: 'focusDevice', id: a.id });
    else if (a.type === 'openDevice' && a.id) send({ type: 'openDevice', id: a.id, ...(a.part ? { part: a.part } : {}) });
    else if (a.type === 'focusPart' && a.id && a.part) send({ type: 'focusPart', id: a.id, part: a.part });
  }
}

/** The room's look for the welcome, and for "movie time" (also the fallback when the assistant is offline). */
// it is night: the curtain stays closed and the window panes dark until he asks for the view
const WELCOME: [string, string, Record<string, unknown>][] = [
  ['Aqara Roller Shade Controller', 'setPosition', { percent: 0 }],
  ['Left Window Light', 'power', { on: 'false' }], ['Right Window Light', 'power', { on: 'false' }],
  ['TV lamp', 'power', { on: 'true' }],
  ['Light 1', 'setColorTemperature', { kelvin: 2700 }], ['Light 1', 'setLevel', { percent: 70 }], ['Light 2', 'setLevel', { percent: 60 }],
  ['Light 3', 'setLevel', { percent: 60 }], ['Light 4', 'setLevel', { percent: 60 }],
  ['side lamp', 'power', { on: 'true' }],
  ['Ceiling AC', 'power', { on: 'true' }], ['Ceiling AC', 'setTemperature', { celsius: 24 }],
  ['TV 65"', 'power', { on: 'true' }],
];
const VIEW: [string, string, Record<string, unknown>][] = [
  ['Aqara Roller Shade Controller', 'setPosition', { percent: 100 }],
  ['Left Window Light', 'power', { on: 'true' }], ['Right Window Light', 'power', { on: 'true' }],
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
/** Run device commands in order; what each did, in words (for the phone when the story acts for the assistant). */
async function run(c: Ctx, list: [string, string, Record<string, unknown>][], gap = 450) {
  const out: { label: string; summary: string; ok: boolean }[] = [];
  for (const [n, command, args] of list) {
    const r: any = await c.cmd(n, command, args).catch(e => ({ ok: false, error: String(e) }));
    const label = c.dev(n)?.name ?? n;
    const v = args.on === 'true' ? 'on' : args.on === 'false' ? 'off' : command === 'setPosition' ? humanize(`setShadeLevel ${args.percent}`)
      : command === 'setLevel' ? humanize(`setLevel ${args.percent}`) : command === 'setTemperature' ? `${args.celsius} °C`
      : command === 'setColor' ? String(args.color) : command === 'setColorTemperature' ? humanize(`setColorTemperature ${args.kelvin}`) : humanize(command);
    out.push({ label, summary: r && r.ok !== false && !r.error ? v : "didn't respond", ok: !!r && r.ok !== false && !r.error });
    await c.wait(gap);
  }
  return out;
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
        const devs = c.devs();
        const kg = await c.api('/api/kg').catch(() => null);
        const real = kg?.stats?.real ?? 0, rooms = kg?.stats?.rooms ?? new Set(devs.map(d => d.room)).size;
        c.caption('Every SmartThings device reports in', `${rooms} rooms, ${devs.length} devices${real ? `, ${real} of them real SmartThings devices` : ''}: live, and known to the assistant.`);
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
        c.caption(`${GUEST} checks in`, 'The front desk just asks the assistant. It issues a pass for Room 401: a link, a QR code and a PIN, valid for his stay only.');
        const lines: ChatLine[] = [];
        const r = await converse(c, '/api/chat', lines, `Check ${GUEST} into the SmartThings Experience Zone for 14 hours`, { title: 'Front desk' });
        let token = '', pin = '';
        if (r.card?.link) { token = String(r.card.link).split('/guest/')[1] ?? ''; pin = r.card.pin ?? ''; lines.push(said(r, 'Checked in.')); c.phone({ kind: 'guest', title: 'Front desk', lines, status: 'Pass issued' }); await c.wait(3500); }
        if (!token) { const p = await c.api('/api/guest', { method: 'POST', body: { room: ROOM, label: GUEST, hours: 14 } }); token = p.token; pin = p.pin ?? ''; }   // assistant offline
        c.state.token = token;
        if (pin) await c.api(`/api/guest/${token}/verify`, { method: 'POST', body: { pin } }).catch(() => null);   // he enters the PIN on arrival
        const QRCode = (await import('qrcode')).default;
        const url = `${location.origin}/guest/${token}`;
        c.phone({ kind: 'pass', qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }), url, pin: pin || undefined, room: 'Room 401 · SmartThings Experience Zone' });
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
        c.state.inRoom = !!(await c.waitFor(m => m.type === 'walk' && (m as any).guest === 'arrived', 70000));
        await c.wait(800);
      },
      async c => {
        c.caption('The door opens for his pass only', 'Unlocked through SmartThings, written to the audit log, locks again by itself.');
        const lock = c.dev('Door lock');
        prev(lock?.id, { locked: false }, 'Unlocked');
        await c.cmd('Door lock', 'unlock', {}).catch(() => null); await c.wait(2500);
      },
      async c => {
        c.caption('The room welcomes him', 'Warm lights fade up, the AC starts and the TV says hello. It is night, so the curtain stays closed.');
        const tv = c.dev('TV 65"');
        await run(c, WELCOME, 500);
        if (tv) story('tv', { id: tv.id, text: 'Welcome, Marufur', sub: 'Room 401 · Enjoy your stay' });
        c.phone({ kind: 'guest', lines: [{ who: 'system', text: 'You are in **Room 401**. Warm lights, AC at 24 °C and the TV are on for you.' }], status: 'In Room 401' });
        await c.wait(5000);
      },
    ],
  },
  {
    key: 'stay', title: 'The smart stay', when: 'Thursday · 22:30',
    steps: [
      async c => {
        if (!c.state.token) { const p = await c.api('/api/guest', { method: 'POST', body: { room: ROOM, label: GUEST } }); c.state.token = p.token; }
        const url = `/api/guest/${c.state.token}/chat`;
        if (!c.state.inRoom) { story('room', { room: ROOM, pitch: -50, yaw: 20, secs: 2 }); await c.wait(1500); }   // started here: watch the room from above
        c.caption('He says what he wants, not which device', 'The assistant knows the windows are back-lit panes behind the curtain, reads their state and works out what to do.');
        const lines: ChatLine[] = [];
        const q = 'Open the window and close the curtain, I want to see the outside view.';
        const r = await converse(c, url, lines, q, { title: 'Room 401' });
        if (answered(r)) { lines.push(said(r, 'Done.')); reflect(c, r); }
        else {   // assistant offline: the story does what it would do, and says so the same way
          spot(c, idsOf(c, VIEW));
          lines.push(await act(c, VIEW, 'To see outside, the curtain has to be **open**, not closed, so I rolled it all the way up and lit both windows.'));
        }
        c.phone({ kind: 'guest', title: 'Room 401', lines, status: 'City view' });
        c.state.lines = lines; c.state.history = [{ role: 'user', content: q }, { role: 'assistant', content: lines[lines.length - 1].text }];
        await c.wait(6500);
      },
      async c => {
        const url = `/api/guest/${c.state.token}/chat`;
        const lines: ChatLine[] = [...(c.state.lines ?? [])];
        const q = "I'm a bit cold, and it's movie time.";
        c.caption('Then he asks for a feeling', 'Warmer, darker, the film on: the assistant reasons from the room\'s live state and changes only what is needed.');
        send({ type: 'clearHighlight' });
        const r = await converse(c, url, lines, q, { title: 'Room 401', history: c.state.history });
        if (answered(r)) { lines.push(said(r, 'Done. Enjoy the film.')); reflect(c, r); }
        else {
          spot(c, idsOf(c, MOVIE));
          lines.push(await act(c, MOVIE, 'Warmer and darker for the film: the AC is up to **26 °C**, the lights are down with a **purple glow** behind the TV, and the curtain is closed. Enjoy!'));
        }
        const tv = c.dev('TV 65"'); if (tv) story('tv', { id: tv.id, text: '' });   // the welcome card gives way to the film
        c.phone({ kind: 'guest', title: 'Room 401', lines, status: 'Movie time' });
        c.state.lines = lines; c.state.offer = r.offer;
        c.state.history = [...c.state.history, { role: 'user', content: q }, { role: 'assistant', content: lines[lines.length - 1].text }];
        await c.wait(6000);
      },
      async c => {
        const lines: ChatLine[] = [...(c.state.lines ?? [])];
        c.caption('It learns his favourite', 'The assistant offers to keep the scene as a routine; one word next time sets the whole room.');
        send({ type: 'clearHighlight' });
        if (c.state.offer) {
          const r = await converse(c, `/api/guest/${c.state.token}/chat`, lines, 'Yes, save it as Movie for two', { title: 'Room 401', history: c.state.history });
          lines.push(said(r, 'Saved as **Movie for two**. Say it any time and the room is set again.'));
        } else lines.push({ who: 'system', text: 'Tip: after a change, say **save this as a routine** to keep it.' });
        c.phone({ kind: 'guest', title: 'Room 401', lines, status: 'Movie time' });
        await c.wait(5000);
      },
    ],
  },
  {
    key: 'fault', title: 'Something breaks', when: 'Friday · 02:10',
    steps: [
      async c => {
        story('endWalk', { fly: false }); story('room', { room: ROOM, pitch: -46, yaw: -20, secs: 2.5 });
        c.phone({ kind: 'off' }); c.state.inRoom = false;   // he is asleep; the view goes back above the floor
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
        const alert = { title: `${c.state.fault ?? 'Refrigerant leak'} · Room 401 AC`, detail, who: String(who), parts: partsTxt };
        c.phone({ kind: 'tech', alert });
        await c.wait(3000);
        c.caption('He asks the assistant what is wrong', 'It reads the unit\'s parts, the evidence and the guided steps; the twin shows the unit it is talking about.');
        const lines: ChatLine[] = [{ who: 'guest', text: "What's wrong with the Ceiling AC in Room 401?" }];
        c.phone({ kind: 'tech', alert, lines: [...lines, { who: 'assistant', text: '', thinking: 'Reading the evidence…' }] });
        const r = await agent('/api/chat', [{ role: 'user', content: "What's wrong with the Ceiling AC in the SmartThings Experience Zone and how do I fix it?" }],
          p => c.phone({ kind: 'tech', alert, lines: [...lines, { who: 'assistant', text: '', thinking: thought(p) }] })).catch(() => null);
        if (r && answered(r)) { lines.push(said(r, '')); reflect(c, r); }
        else lines.push({ who: 'assistant', text: '**Most likely a refrigerant leak** at a flare joint: superheat is high and the gas pipe runs warm.\n1. Check the flare joints with a leak detector.\n2. Repair the leaking joint.\n3. Recharge to the nameplate weight and confirm superheat is back to about 5 K.' });
        if (c.state.ac && !(r?.actions ?? []).some(a => a.type === 'openDevice' || a.type === 'focusDevice')) send({ type: 'focusDevice', id: c.state.ac });
        c.phone({ kind: 'tech', alert, lines }); c.state.techLines = lines; c.state.alert = alert;
        await c.wait(6000);
      },
      async c => {
        c.caption('He follows the twin to the unit', 'Shortest way from the service area; the route avoids the guest corridor where it can.');
        send({ type: 'closeDevice' }); await c.wait(400);
        story('walk', { room: ROOM, from: TECH_FROM });
        await c.waitFor(m => m.type === 'walk' && (m as any).guest === 'arrived', 70000);
        await c.wait(800);
      },
      async c => {
        c.caption('Fixed, and the twin confirms it', 'He tells the assistant what he did; it records the cause and the repair and the readings go back to normal.');
        const lines: ChatLine[] = [...(c.state.techLines ?? [])];
        const r = c.state.alert ? await converse(c, '/api/chat', lines, 'Fixed the Ceiling AC in Room 401: the flare joint was leaking, I tightened it and recharged the gas. Mark it fixed.', { title: 'Technician' }) : null;
        if (r && answered(r)) lines.push(said(r, 'Recorded.'));
        else lines.push({ who: 'assistant', text: 'Recorded: **flare joint leak**, tightened and recharged. The alert is closed and the unit reads normal again.' });
        if (c.state.ac) await c.api(`/api/devices/${c.state.ac}/fault`, { method: 'DELETE' }).catch(() => null);   // already cleared when the assistant fixed it
        if (c.state.alert) c.phone({ kind: 'tech', alert: c.state.alert, lines });
        send({ type: 'clearHighlight' }); c.stat('Alerts', '0');
        await c.wait(4500); story('endWalk', { fly: true });
      },
    ],
  },
  {
    key: 'ops', title: "The operator's view", when: 'Friday · 03:00 – 08:00',
    steps: [
      async c => {
        story('endWalk', { fly: false }); story('night', { on: true }); c.phone({ kind: 'off' });
        // the same numbers as Live ops: measured where a device reports power, modelled from its live state elsewhere
        const en = await c.api('/api/energy').catch(() => null);
        const e: Record<string, number> = {};
        if (Array.isArray(en?.rooms)) for (const r of en.rooms) e[r.key] = Number(r.kwh) || 0;
        else Object.assign(e, energy(c.devs()));
        const many = Object.values(e).filter(v => v > 0.05).length > 1;
        if (many) story('shot', { target: [0, 0], distance: 60, pitch: -62, yaw: 0, secs: 3 });
        else story('room', { room: ROOM, pitch: -58, yaw: 0, secs: 3 });
        const max = Math.max(0.1, ...Object.values(e));
        const values: Record<string, number> = {}, labels: Record<string, string> = {};
        for (const [k, v] of Object.entries(e)) if (v > 0.05) { values[k] = v / max; labels[k] = `${v.toFixed(1)} kWh`; }
        story('heat', { values, labels, on: true });
        c.caption('Night shift: energy by room', `${many ? 'Each room' : 'Room 401'} coloured by the energy it has used today, the same figures as Live ops.`);
        if (en?.kwh != null) c.stat('Today', `${Number(en.kwh).toFixed(1)} kWh`);
        await c.wait(7500);
      },
      async c => {
        c.caption('The operator asks what happened overnight', 'Every action on the floor is in the assistant\'s knowledge graph: who did what, when, and what the devices reported.');
        const ops: ChatLine[] = [];
        const r = await converse(c, '/api/chat', ops, 'What happened in the SmartThings Experience Zone tonight?', { title: 'Operator' });
        ops.push(answered(r) ? said(r, '') : { who: 'assistant', text: '- **21:15** Marufur Rahaman checked in, welcome scene\n- **22:30** city view, then movie scene saved as a routine\n- **02:10** AC refrigerant leak, fixed by the HVAC technician' });
        c.phone({ kind: 'guest', title: 'Operator', lines: ops, status: 'Night report' });
        await c.wait(7000);
      },
      async c => {
        c.caption('08:00. Marufur checks out', 'The front desk asks the assistant. His pass stops working and Room 401 switches itself to eco: AC, lights and TV off, curtain closed, housekeeping called.');
        const power = async () => { const x = await c.api('/api/energy').catch(() => null); return (x?.rooms ?? []).find((r: any) => r.key === ROOM)?.w as number | undefined; };
        const before = await power();
        const ops: ChatLine[] = [];
        const r = await converse(c, '/api/chat', ops, `Check out ${GUEST}`, { title: 'Front desk' });
        if (!answered(r) || !/checked out/i.test(r.text)) { if (c.state.token) await c.api(`/api/guest/${c.state.token}`, { method: 'DELETE' }).catch(() => null); }
        ops.push(answered(r) ? said(r, 'Checked out.') : { who: 'assistant', text: `**${GUEST}** is checked out. His pass no longer opens Room 401.` });
        c.phone({ kind: 'guest', title: 'Front desk', lines: ops, status: 'Checked out' });
        const tv = c.dev('TV 65"'); if (tv) story('tv', { id: tv.id, text: '' });
        story('heat', { on: false });   // watch the room itself go dark
        story('room', { room: ROOM, pitch: -60, yaw: 0, secs: 2 });
        // the arrival service puts the room to eco on checkout (within a couple of seconds); wait for the room to drop
        let after = before;
        for (let i = 0; i < 8; i++) { await c.wait(1000); after = await power(); if (before != null && after != null && after < before * 0.6) break; }
        if (before != null && after != null && after >= before * 0.6) { await run(c, OFF, 200); after = await power(); }   // no eco (older server): switch off directly
        if (before != null && after != null) {
          ops.push({ who: 'system', text: `Room 401 is in **eco**: ${Math.round(before)} W → **${Math.round(after)} W**. Housekeeping is on its way.` });
          c.phone({ kind: 'guest', title: 'Front desk', lines: ops, status: 'Checked out' });
          c.stat('Room 401', `${Math.round(before)} → ${Math.round(after)} W`);
        }
        await c.wait(5000);
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
  c.stat('Alerts', '0'); c.stat('Today', null); c.stat('Room 401', null);
}
