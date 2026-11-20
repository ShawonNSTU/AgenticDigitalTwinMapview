'use client';
import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';

type Pass = { token: string; room: string; roomName: string; entranceName: string; label: string; expiresAt: number; path: string; pin: string; allowUnlock: boolean };
type Entrance = { key: string; name: string };

// default checkout: tomorrow at 12:00, as a local datetime-local value
const checkoutDefault = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(12, 0, 0, 0); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T12:00`; };
const when = (ms: number) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Guest QR for one room: whoever scans it walks from the entrance to this room in 3D and can see and
 *  control only this room's devices, until the pass expires or is withdrawn. */
export default function GuestQr({ room, roomName, onClose }: { room: string; roomName: string; onClose: () => void }) {
  const [checkout, setCheckout] = useState(checkoutDefault());
  const [verify, setVerify] = useState(true);
  const [unlock, setUnlock] = useState(false);
  const [tag, setTag] = useState('');
  // the room's device types, and which of them this guest may control (all by default)
  const [types, setTypes] = useState<{ type: string; label: string }[]>([]);
  const [allowed, setAllowed] = useState<Record<string, boolean>>({});
  const [acMin, setAcMin] = useState(18);
  const [acMax, setAcMax] = useState(28);
  useEffect(() => {
    fetch('/api/devices').then(r => r.json()).then(x => {
      const seen = new Map<string, string>();
      for (const d of x.devices) if (d.room === room && !seen.has(d.type)) seen.set(d.type, d.label);
      const list = [...seen].map(([type, label]) => ({ type, label }));
      setTypes(list); setAllowed(Object.fromEntries(list.map(t => [t.type, true])));
    });
  }, [room]);
  const [entrance, setEntrance] = useState('');
  const [label, setLabel] = useState('');
  const [entrances, setEntrances] = useState<Entrance[]>([]);
  const [defEntrance, setDefEntrance] = useState('');
  const [passes, setPasses] = useState<Pass[]>([]);
  const [made, setMade] = useState<Pass | null>(null);
  const [qr, setQr] = useState('');
  const [base, setBase] = useState('');
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => fetch(`/api/guest?room=${encodeURIComponent(room)}`).then(r => r.json()).then(x => { setPasses(x.passes); setEntrances(x.entrances); setDefEntrance(x.defaultEntrance ?? ''); }), [room]);
  useEffect(() => { load(); setBase(window.location.origin); }, [load]);
  const url = (p: Pass) => `${base.replace(/\/$/, '')}${p.path}`;
  useEffect(() => {
    if (!made) return;
    QRCode.toDataURL(url(made), { width: 520, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#0f172a', light: '#ffffff' } }).then(setQr);
  }, [made, base]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    setErr('');
    const r = await fetch('/api/guest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room, until: new Date(checkout).getTime(), entrance: entrance || undefined, label: label || undefined, verify, allowUnlock: verify && unlock, tag: tag || undefined,
        controls: types.every(t => allowed[t.type]) ? undefined : types.filter(t => allowed[t.type]).map(t => t.type), acRange: [acMin, acMax] }) });
    const d = await r.json();
    if (!r.ok) { setErr(d.error ?? 'Could not create the pass'); return; }
    setMade(d); load();
  };
  const withdraw = async (token: string) => { await fetch(`/api/guest/${token}`, { method: 'DELETE' }); if (made?.token === token) { setMade(null); setQr(''); } load(); };
  const local = /localhost|127\.0\.0\.1|\[::1\]/.test(base);

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal glass" role="dialog" aria-label={`Guest QR for ${roomName}`} onClick={e => e.stopPropagation()}>
        <button className="hint-close" aria-label="Close" onClick={onClose}>✕</button>
        <h3>Guest check-in · {roomName}</h3>
        <p className="muted">A guest who scans this code walks from the entrance to this room in 3D, and can see and control only this room&apos;s devices. Doors to other rooms stay shut. Unlocking doors is never allowed.</p>
        {!made ? (
          <div className="qr-form">
            <label>Guest name<input value={label} maxLength={60} placeholder="e.g. Ms. Rahman" onChange={e => setLabel(e.target.value)} /></label>
            <label>Checkout (access ends)<input type="datetime-local" value={checkout} onChange={e => setCheckout(e.target.value)} /></label>
            <label>Walk starts at<select value={entrance} onChange={e => setEntrance(e.target.value)}>
              <option value="">{defEntrance ? `${entrances.find(x => x.key === defEntrance)?.name ?? defEntrance} (default)` : 'Nearest entrance (automatic)'}</option>
              {entrances.filter(x => x.key !== defEntrance).map(x => <option key={x.key} value={x.key}>{x.name}</option>)}
            </select></label>
            <label>Location badge (optional: the tag id of the badge or key card the hotel's positioning system tracks)<input value={tag} maxLength={64} placeholder="e.g. BADGE-0042" onChange={e => setTag(e.target.value.trim())} /></label>
            {types.length > 0 && (
              <div className="perm">
                <span className="muted">Room controls the guest may use (others are shown but view-only)</span>
                <div className="perm-list">{types.map(t => <label key={t.type} className="chk"><input type="checkbox" checked={!!allowed[t.type]} onChange={e => setAllowed(a => ({ ...a, [t.type]: e.target.checked }))} /> {t.label}</label>)}</div>
                {types.some(t => t.type === 'ac') && <label className="row-lbl">AC temperature allowed <input type="number" min={16} max={30} value={acMin} onChange={e => setAcMin(+e.target.value)} /> to <input type="number" min={16} max={30} value={acMax} onChange={e => setAcMax(+e.target.value)} /> °C</label>}
              </div>
            )}
            <label className="chk"><input type="checkbox" checked={verify} onChange={e => setVerify(e.target.checked)} /> Verify identity with a check-in PIN (handed over at the desk)</label>
            <label className={`chk ${verify ? '' : 'dim'}`}><input type="checkbox" disabled={!verify} checked={verify && unlock} onChange={e => setUnlock(e.target.checked)} /> Let the guest unlock this room&apos;s door (hotel policy; uses the SmartThings lock when linked on Integrations)</label>
            {err && <div className="bad-text">{err}</div>}
            <button className="pri" onClick={create}>Create QR code</button>
          </div>
        ) : (
          <div className="qr-out">
            {qr ? <img src={qr} alt={`QR code for guest access to ${roomName}`} width={240} height={240} /> : <div className="qr-wait"><span className="spinner" /></div>}
            <div className="qr-side">
              <b>{made.roomName}</b>
              <span className="muted">Valid until {when(made.expiresAt)}{made.entranceName ? ` · starts at ${made.entranceName}` : ''}</span>
              {made.pin && <div className="pin-out"><small>Check-in PIN (give it to the guest, not printed on the QR)</small><b>{made.pin}</b></div>}
              {made.allowUnlock && <span className="muted">Door unlock allowed for this guest.</span>}
              <label>Link address<input value={base} onChange={e => setBase(e.target.value)} /></label>
              {local && <span className="warn-text">Phones can&apos;t open “localhost”. Put this computer&apos;s network address here (for example http://192.168.1.20:3000) before printing.</span>}
              <code className="qr-url">{url(made)}</code>
              <div className="row">
                <button onClick={() => { navigator.clipboard?.writeText(url(made)); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? 'Copied' : 'Copy link'}</button>
                {qr && <a href={qr} download={`guest-qr-${made.room}.png`}><button>Download PNG</button></a>}
                <a href={made.path} target="_blank" rel="noreferrer"><button>Open as guest</button></a>
              </div>
              <button className="ghost" onClick={() => { setMade(null); setQr(''); }}>Make another</button>
            </div>
          </div>
        )}
        {passes.length > 0 && (
          <div className="qr-list">
            <b>Active passes for this room</b>
            {passes.map(p => (
              <div key={p.token} className="qr-row">
                <span>{p.label || 'Guest'} · until {when(p.expiresAt)}{p.pin ? ` · PIN ${p.pin}` : ''}{p.allowUnlock ? ' · may unlock' : ''}</span>
                <button className="danger" onClick={() => withdraw(p.token)}>Withdraw</button>
              </div>))}
          </div>
        )}
      </div>
    </div>
  );
}
