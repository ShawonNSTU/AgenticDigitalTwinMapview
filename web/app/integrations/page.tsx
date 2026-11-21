'use client';
import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';

type Link = { localId: string; stId: string; component: string; label?: string; type: string };
type StDev = { stId: string; label: string; capabilities: string[]; room?: string; type?: string | null };
type Sync = { found: number; already: number; room: string | null; linked: { localId: string; label: string; how: 'name' | 'slot' | 'added' }[]; unplaced: { label: string; type: string | null; room: string; reason: string }[]; simulated: { localId: string; name: string }[] };
type Dev = { id: string; type: string; label: string; room: string; name: string };
type Policy = { stepUpMinutes: number; maxUnlocksPer10Min: number; autoRelockSec: number };
type Audit = { at: number; deviceId: string; room: string; action: string; by: string; ok: boolean; reason: string; via: string };
type Cp = { id: string; x: number; z: number; label: string; room: string };

const CONTROLLED = ['lock', 'light', 'ac', 'tv', 'blinds', 'fan', 'plug', 'purifier', 'vacuum', 'temphum'];
const json = (r: Response) => r.json();
const post = (url: string, body: object, method = 'POST') => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json);

/** Host settings for real-world integration: SmartThings devices (commands and live status), the door-access
 *  policy with its audit log, and indoor positioning (RTLS webhook, location QR codes, step tracking). */
export default function Integrations() {
  const [st, setSt] = useState<{ configured: boolean; api: string; links: Link[]; lastError: string } | null>(null);
  const [token, setToken] = useState('');
  const [acct, setAcct] = useState<StDev[]>([]);
  const [acctErr, setAcctErr] = useState('');
  const [devs, setDevs] = useState<Dev[]>([]);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [pos, setPos] = useState<{ config: { northDeg: number; stepLength: number; rtlsKey: string }; webhook: string; checkpoints: Cp[] } | null>(null);
  const [qrs, setQrs] = useState<Record<string, string>>({});
  const [origin, setOrigin] = useState('');
  const [msg, setMsg] = useState('');
  const [sync, setSync] = useState<Sync | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const i = await fetch('/api/integrations').then(json); setSt(i.smartthings); setPolicy(p => p ?? i.lockPolicy);
    setDevs((await fetch('/api/devices').then(json)).devices);
    setAudit((await fetch('/api/locks').then(json)).audit);
    setPos(await fetch('/api/positioning').then(json));
    if (i.smartthings.configured) fetch('/api/integrations/smartthings').then(async r => { const d = await r.json(); if (r.ok) { setAcct(d.devices); setAcctErr(''); } else setAcctErr(d.error); });
  }, []);
  useEffect(() => { load(); setOrigin(window.location.origin); const h = setInterval(() => fetch('/api/locks').then(json).then(x => setAudit(x.audit)), 4000); return () => clearInterval(h); }, [load]);
  useEffect(() => {
    if (!pos || !origin) return;
    Promise.all(pos.checkpoints.map(async c => [c.id, await QRCode.toDataURL(`${origin}/here/${c.id}`, { width: 220, margin: 1 })] as const)).then(x => setQrs(Object.fromEntries(x)));
  }, [pos, origin]);

  const flash = (t: string) => { setMsg(t); setTimeout(() => setMsg(''), 3000); };
  // Connect checks the token with SmartThings and brings the account's devices onto the map straight away
  const connect = async () => {
    setBusy(true);
    const d = await post('/api/integrations', { token }).finally(() => setBusy(false));
    setSt(d.smartthings); setToken('');
    if (d.error) { setSync(null); flash(d.error); }
    else if (d.sync) { setSync(d.sync); flash(`Connected · ${d.sync.found} devices found, ${d.sync.linked.length + d.sync.already} on the map`); }
    else { setSync(null); flash('Disconnected'); }
    load();
  };
  const resync = async () => { setBusy(true); const d = await post('/api/integrations/smartthings', { sync: true }).finally(() => setBusy(false)); if (d.error) flash(d.error); else { setSync(d.sync); flash(d.sync.linked.length ? `${d.sync.linked.length} more on the map` : 'Everything is on the map already'); } load(); };
  const dropSimulated = async () => {
    if (!confirm('Remove the devices in the SmartThings Experience Zone that have no real SmartThings device?')) return;
    const d = await post('/api/integrations/smartthings', { removeSimulated: true });
    flash(`${d.removed?.length ?? 0} simulated devices removed`); setSync(x => x ? { ...x, simulated: [] } : x); load();
  };
  const doLink = async (localId: string) => {
    const stId = pick[localId]; if (!stId) return;
    const d = await post('/api/integrations/links', { localId, stId, label: acct.find(a => a.stId === stId)?.label });
    if (d.error) flash(d.error); else { flash(`${localId} linked`); load(); }
  };
  const byName = async () => {
    const d = await post('/api/integrations/links', { byName: true });
    if (d.error) flash(d.error); else { flash(d.linked.length ? `${d.linked.length} linked by name` : 'No twin device has a SmartThings device of the same name'); load(); }
  };
  const unlink = async (localId: string) => { await fetch(`/api/integrations/links?localId=${localId}`, { method: 'DELETE' }); load(); };
  const linkOf = (id: string) => st?.links.find(l => l.localId === id);

  return (
    <main className="settings">
      <header className="topbar">
        <div className="brand"><span className="logo" /><div><b>Integrations</b><small>Devices · door access · indoor positioning</small></div></div>
        <div className="stats">{msg && <span className="stat good">{msg}</span>}<a href="/"><button className="ghost">Floor map</button></a><a href="/tech"><button className="ghost">Technician</button></a></div>
      </header>
      <div className="settings-body">
        <section className="card">
          <h3>SmartThings</h3>
          <p className="muted">Link devices on the twin to real SmartThings devices. Commands to a linked device (from the host, guests or the assistants) go to SmartThings; its reported status replaces the simulated values. Other devices stay simulated.</p>
          <div className="row"><span className={`badge ${st?.configured ? 'ok' : 'watch'}`}>{st?.configured ? 'Connected' : 'Not connected'}</span><span className="muted">{st?.api}</span></div>
          <div className="row"><input type="password" placeholder="Personal access token (devices: read, execute; locations: read)" value={token} onChange={e => setToken(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && token) connect(); }} /><button className="pri" disabled={busy || (!token && !st?.configured)} onClick={connect}>{busy ? 'Connecting…' : st?.configured && !token ? 'Disconnect' : 'Connect'}</button></div>
          <span className="muted">Create a token at account.smartthings.com/tokens. Connecting fetches every device in the account and puts it on the map: on the 4th floor in the SmartThings Experience Zone, taking the place of the simulated device it matches; on other floors in the room with the same name as its SmartThings room. Or set SMARTTHINGS_TOKEN on the server. A token entered here is kept in memory only.</span>
          {sync && (
            <div className="sync-card">
              <b>{sync.found} devices in the account · {sync.linked.length + sync.already} on the map{sync.room ? ` (${sync.room})` : ''}{sync.already ? ` · ${sync.already} were linked already` : ''}</b>
              {sync.linked.length > 0 && <ul>{sync.linked.map(l => <li key={l.localId}><b>{l.label}</b> → {l.localId} <span className="muted">{l.how === 'name' ? 'same name' : l.how === 'slot' ? 'took the place of a simulated device' : 'added at a free spot'}</span></li>)}</ul>}
              {sync.unplaced.length > 0 && <><span className="muted">Not on the map:</span><ul>{sync.unplaced.map((u, i) => <li key={i}>{u.label} <span className="muted">· {u.reason}</span></li>)}</ul></>}
              {sync.simulated.length > 0 && <div className="row"><span className="muted grow">{sync.simulated.length} devices in the zone have no real device and stay simulated: {sync.simulated.map(x => x.name).join(', ')}.</span><button onClick={dropSimulated}>Remove them</button></div>}
            </div>
          )}
          {st?.lastError && <div className="bad-text">Last error: {st.lastError}</div>}
          {acctErr && <div className="bad-text">{acctErr}</div>}
          {st?.configured && <div className="row"><button disabled={busy} onClick={resync}>Fetch devices again</button><button onClick={byName}>Link by name</button><span className="muted">Links every twin device whose name is the name of a device in the SmartThings app (the SmartThings Experience Zone uses the app's names).</span></div>}
          <table className="tbl">
            <thead><tr><th>Twin device</th><th>Room</th><th>SmartThings device</th><th /></tr></thead>
            <tbody>{devs.filter(d => CONTROLLED.includes(d.type)).map(d => {
              const l = linkOf(d.id);
              return (
                <tr key={d.id}>
                  <td><b>{d.id}</b> {d.label}</td><td>{d.name.split(' · ')[1]}</td>
                  <td>{l ? <span>{l.label ?? l.stId} <span className="muted">({l.stId.slice(0, 8)}…)</span></span> : (
                    acct.length ? <select value={pick[d.id] ?? ''} onChange={e => setPick(p => ({ ...p, [d.id]: e.target.value }))}><option value="">Choose…</option>{acct.map(a => <option key={a.stId} value={a.stId}>{a.label}{a.room ? ` (${a.room})` : ''}</option>)}</select>
                      : <input placeholder="SmartThings device id" value={pick[d.id] ?? ''} onChange={e => setPick(p => ({ ...p, [d.id]: e.target.value.trim() }))} disabled={!st?.configured} />)}</td>
                  <td>{l ? <button onClick={() => unlink(d.id)}>Unlink</button> : <button disabled={!st?.configured || !pick[d.id]} onClick={() => doLink(d.id)}>Link</button>}</td>
                </tr>);
            })}</tbody>
          </table>
        </section>

        <section className="card">
          <h3>Door access policy</h3>
          <p className="muted">Guests may unlock only their own room&apos;s door, only if their pass allows it, after the check-in PIN, during their stay. Every lock and unlock attempt is logged.</p>
          {policy && <div className="grid3">
            <label>Ask for the PIN again after (minutes)<input type="number" min={0} value={policy.stepUpMinutes} onChange={e => setPolicy({ ...policy, stepUpMinutes: +e.target.value })} /></label>
            <label>Most unlocks per 10 minutes<input type="number" min={1} value={policy.maxUnlocksPer10Min} onChange={e => setPolicy({ ...policy, maxUnlocksPer10Min: +e.target.value })} /></label>
            <label>Lock again after (seconds, 0 = never)<input type="number" min={0} value={policy.autoRelockSec} onChange={e => setPolicy({ ...policy, autoRelockSec: +e.target.value })} /></label>
          </div>}
          <button className="pri" onClick={async () => { const d = await post('/api/integrations', { policy }); setPolicy(d.lockPolicy); flash('Policy saved'); }}>Save policy</button>
          <h4>Access log</h4>
          {audit.length === 0 ? <div className="muted">No lock activity yet.</div> : (
            <table className="tbl"><thead><tr><th>When</th><th>Lock</th><th>Action</th><th>By</th><th>Result</th><th>Via</th></tr></thead>
              <tbody>{audit.slice(0, 40).map((a, i) => <tr key={i}><td>{new Date(a.at).toLocaleTimeString()}</td><td>{a.deviceId}</td><td>{a.action}</td><td>{a.by}</td><td className={a.ok ? 'ok-text' : 'bad-text'}>{a.ok ? 'done' : `refused: ${a.reason}`}</td><td>{a.via}</td></tr>)}</tbody></table>
          )}
        </section>

        <section className="card">
          <h3>Indoor positioning</h3>
          <p className="muted">Guests can follow their live position in 3D. Fixes come from the hotel&apos;s positioning system (badges), from location QR codes on the walls, and between them from the phone&apos;s step tracking.</p>
          {pos && <>
            <div className="grid3">
              <label>Plan “up” points to (compass degrees)<input type="number" value={pos.config.northDeg} onChange={e => setPos({ ...pos, config: { ...pos.config, northDeg: +e.target.value } })} /></label>
              <label>Step length (m)<input type="number" step={0.05} value={pos.config.stepLength} onChange={e => setPos({ ...pos, config: { ...pos.config, stepLength: +e.target.value } })} /></label>
              <div className="row end"><button className="pri" onClick={async () => { await post('/api/positioning', { northDeg: pos.config.northDeg, stepLength: pos.config.stepLength }); flash('Saved'); }}>Save</button></div>
            </div>
            <h4>Positioning system (RTLS) webhook</h4>
            <p className="muted">Bind a badge to a guest at check-in (the badge tag on the guest QR form). The positioning system posts fixes in floor metres:</p>
            <pre className="code">{`curl -X POST ${origin}${pos.webhook} \\
  -H 'x-rtls-key: ${pos.config.rtlsKey}' -H 'Content-Type: application/json' \\
  -d '{"tag":"BADGE-0042","x":12.4,"z":-3.1,"accuracy":0.4}'`}</pre>
            <div className="row between"><h4>Location QR codes ({pos.checkpoints.length})</h4><button onClick={() => window.print()}>Print the codes</button></div>
            <p className="muted">Put each code on the wall at its spot (beside the door it names, or in the stair or lift). Scanning one with the phone camera fixes the guest&apos;s position to about a metre.</p>
            <div className="cp-sheet">{pos.checkpoints.map(c => <div key={c.id} className="cp">{qrs[c.id] && <img src={qrs[c.id]} alt={`Location code: ${c.label}`} width={130} height={130} />}<b>{c.label}</b><small>{c.id} · x {c.x}, z {c.z}</small></div>)}</div>
          </>}
        </section>
      </div>
    </main>
  );
}
