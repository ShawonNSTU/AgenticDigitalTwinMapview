import { NextRequest, NextResponse } from 'next/server';

// Host sign-in (optional). With ADMIN_KEY set, only the host can use the map, uploads, devices, agent and
// guest-pass management; guests reach only /guest/<token>, the renderer files and the guest-scoped API
// (/api/guest/<token>, .../building, .../floor, .../devices/<id>/commands). Open the site once with
// ?key=<ADMIN_KEY> to sign in (kept in a cookie). Without ADMIN_KEY everything is open (local demo).
const KEY = process.env.ADMIN_KEY ?? '';

const guestApi = (path: string, method: string) =>
  /^\/api\/guest\/[^/]+\/(building|floor)$/.test(path) && method === 'GET'
  || /^\/api\/guest\/[^/]+\/devices\/[^/]+\/commands$/.test(path) && method === 'POST'
  || /^\/api\/guest\/[^/]+\/(verify|chat|position)$/.test(path) && method === 'POST'
  || /^\/api\/guest\/[^/]+\/position$/.test(path) && method === 'GET'
  || path === '/api/positioning/rtls' && method === 'POST' // checked by its own key
  || /^\/api\/guest\/[^/]+$/.test(path) && method === 'GET';

export function proxy(req: NextRequest) {
  if (!KEY) return NextResponse.next();
  const { pathname, searchParams } = req.nextUrl;
  if (pathname.startsWith('/guest/') || pathname.startsWith('/here/') || pathname.startsWith('/godot/') || pathname.startsWith('/_next/') || pathname === '/favicon.ico' || guestApi(pathname, req.method)) return NextResponse.next();
  if (searchParams.get('key') === KEY) {
    const url = req.nextUrl.clone();
    url.searchParams.delete('key');
    const res = NextResponse.redirect(url);
    res.cookies.set('twin_admin', KEY, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 30 });
    return res;
  }
  if (req.cookies.get('twin_admin')?.value === KEY) return NextResponse.next();
  return pathname.startsWith('/api/')
    ? NextResponse.json({ error: 'Host sign-in required' }, { status: 401 })
    : new NextResponse('This page is for the host. Guests: scan the QR code you were given.', { status: 401, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
