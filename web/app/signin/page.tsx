'use client';
import { useState } from 'react';

/** Sign in as the hotel administrator (host) or a technician. Guests never sign in here: their QR link is
 *  their access. */
export default function SignIn() {
  const [role, setRole] = useState<'host' | 'tech'>('host');
  const [key, setKey] = useState('');
  const [err, setErr] = useState('');
  const go = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    const r = await fetch('/api/signin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, key }) });
    const d = await r.json();
    if (!r.ok) { setErr(d.error); return; }
    const next = new URLSearchParams(window.location.search).get('next');
    window.location.href = next && (role === 'host' || next === '/tech') ? next : d.home;
  };
  return (
    <main className="guest-denied">
      <form className="glass pin-card" onSubmit={go}>
        <span className="logo" />
        <h2>Sign in</h2>
        <div className="seg"><button type="button" className={role === 'host' ? 'on' : ''} onClick={() => setRole('host')}>Administrator</button><button type="button" className={role === 'tech' ? 'on' : ''} onClick={() => setRole('tech')}>Technician</button></div>
        <input type="password" placeholder="Access key" value={key} onChange={e => setKey(e.target.value)} autoFocus />
        {err && <div className="bad-text">{err}</div>}
        <button className="pri" disabled={!key}>Sign in</button>
        <span className="muted">Guests: open the QR code from the front desk instead.</span>
      </form>
    </main>
  );
}
