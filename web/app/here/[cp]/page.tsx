'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

/** Opened by scanning a location QR code on a wall: sends the guest back to their room page with the
 *  checkpoint, which fixes their position in the 3D view. The guest link is remembered on this phone. */
export default function Here() {
  const { cp } = useParams<{ cp: string }>();
  const [none, setNone] = useState(false);
  useEffect(() => {
    let token = '';
    try { token = localStorage.getItem('twin.guestToken') ?? ''; } catch { /* storage unavailable */ }
    if (token) window.location.replace(`/guest/${token}?cp=${encodeURIComponent(cp)}`);
    else setNone(true);
  }, [cp]);
  return (
    <main className="guest-denied"><div className="glass"><span className="logo" /><h2>Location code</h2>
      <p>{none ? 'Open your room link (the QR code from the front desk) on this phone first, then scan this code again.' : 'Finding you on the map…'}</p></div></main>
  );
}
