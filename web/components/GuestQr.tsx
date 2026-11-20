'use client';
import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';

type Pass = { token: string; room: string; roomName: string; entranceName: string; label: string; expiresAt: number; path: string };
type Entrance = { key: string; name: string };

const HOURS = [{ h: 2, t: '2 hours' }, { h: 8, t: '8 hours' }, { h: 24, t: '1 day' }, { h: 24 * 7, t: '7 days' }];
const when = (ms: number) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Guest QR for one room: whoever scans it walks from the entrance to this room in 3D and can see and
 *  control only this room's devices, until the pass expires or is withdrawn. */
export default function GuestQr({ room, roomName, onClose }: { room: string; roomName: string; onClose: () => void }) {
  const [hours, setHours] = useState(24);
  const [entrance, setEntrance] = useState('');
  const [label, setLabel] = useState('');
  const [entrances, setEntrances] = useState<Entrance[]>([]);
  const [passes, setPasses] = useState<Pass[]>([]);
  const [made, setMade] = useState<Pass | null>(null);
  const [qr, setQr] = useState('');
  const [base, setBase] = useState('');
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => fetch(`/api/guest?room=${encodeURIComponent(room)}`).then(r => r.json()).then(x => { setPasses(x.passes); setEntrances(x.entrances); }), [room]);
  useEffect(() => { load(); setBase(window.location.origin); }, [load]);
  const url = (p: Pass) => `${base.replace(/\/$/, '')}${p.path}`;
  useEffect(() => {
    if (!made) return;
    QRCode.toDataURL(url(made), { width: 520, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#0f172a', light: '#ffffff' } }).then(setQr);
  }, [made, base]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    setErr('');
    const r = await fetch('/api/guest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room, hours, entrance: entrance || undefined, label: label || undefined }) });
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
        <h3>Guest access · {roomName}</h3>
        <p className="muted">A guest who scans this code walks from the entrance to this room in 3D, and can see and control only this room&apos;s devices. Doors to other rooms stay shut. Unlocking doors is never allowed.</p>
        {!made ? (
          <div className="qr-form">
            <label>Valid for<select value={hours} onChange={e => setHours(+e.target.value)}>{HOURS.map(x => <option key={x.h} value={x.h}>{x.t}</option>)}</select></label>
            <label>Walk starts at<select value={entrance} onChange={e => setEntrance(e.target.value)}>
              <option value="">Nearest entrance (automatic)</option>
              {entrances.map(x => <option key={x.key} value={x.key}>{x.name}</option>)}
            </select></label>
            <label>For (optional)<input value={label} maxLength={60} placeholder="e.g. Visitor from Acme" onChange={e => setLabel(e.target.value)} /></label>
            {err && <div className="bad-text">{err}</div>}
            <button className="pri" onClick={create}>Create QR code</button>
          </div>
        ) : (
          <div className="qr-out">
            {qr ? <img src={qr} alt={`QR code for guest access to ${roomName}`} width={240} height={240} /> : <div className="qr-wait"><span className="spinner" /></div>}
            <div className="qr-side">
              <b>{made.roomName}</b>
              <span className="muted">Valid until {when(made.expiresAt)}{made.entranceName ? ` · starts at ${made.entranceName}` : ''}</span>
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
                <span>{p.label || 'Guest'} · until {when(p.expiresAt)}{p.entranceName ? ` · from ${p.entranceName}` : ''}</span>
                <button className="danger" onClick={() => withdraw(p.token)}>Withdraw</button>
              </div>))}
          </div>
        )}
      </div>
    </div>
  );
}
