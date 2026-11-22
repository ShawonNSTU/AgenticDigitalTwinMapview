import { NextRequest, NextResponse } from 'next/server';

// Sign-in by role (optional). With ADMIN_KEY (and TECH_KEY) set:
//   host (hotel administrator)  everything
//   technician                  /tech and what it needs: alerts, maintenance, devices, the 3D view, the agent
//   guest                       only /guest/<token>, /here/<code>, the renderer files and the guest-scoped API
// Sign in on /signin (the key is kept in a cookie). Without ADMIN_KEY everything is open (local demo).
const ADMIN = process.env.ADMIN_KEY ?? '';
const TECH = process.env.TECH_KEY ?? '';

const guestApi = (path: string, method: string) =>
  /^\/api\/guest\/[^/]+\/(building|floor|position|journey)$/.test(path) && method === 'GET'
  || /^\/api\/guest\/[^/]+\/journey$/.test(path) && method === 'POST'
  || /^\/api\/guest\/[^/]+\/devices\/[^/]+\/commands$/.test(path) && method === 'POST'
  || /^\/api\/guest\/[^/]+\/(verify|chat|position)$/.test(path) && method === 'POST'
  || /^\/api\/guest\/[^/]+\/chat\/history(\/[A-Za-z0-9_-]+)?$/.test(path) && ['GET', 'PUT', 'PATCH', 'DELETE'].includes(method)   // checked against the pass in the route
  || /^\/api\/guest\/[^/]+$/.test(path) && method === 'GET'
  || path === '/api/positioning/rtls' && method === 'POST'; // checked by its own key

const techAllowed = (path: string, method: string) =>
  path === '/tech' || path.startsWith('/api/alerts') || path.startsWith('/api/maintenance') || path.startsWith('/api/events') || path.startsWith('/api/chat') || path.startsWith('/api/kg')
  || (path.startsWith('/api/technicians') && method === 'GET') || path.startsWith('/api/predictions')
  || (/^\/api\/(energy|comfort|arrivals)/.test(path) && method === 'GET')
  || (/^\/api\/(floor|building|devices|layout)/.test(path) && (method === 'GET' || /\/commands$/.test(path)));

export function proxy(req: NextRequest) {
  if (!ADMIN) return NextResponse.next();
  const { pathname } = req.nextUrl;
  if (pathname.startsWith('/guest/') || pathname.startsWith('/here/') || pathname.startsWith('/godot/') || pathname.startsWith('/_next/')
    || pathname.startsWith('/api/st/v1/') /* the assistant's device API: its own per-turn session token */ || pathname === '/favicon.ico' || pathname === '/signin' || pathname === '/api/signin' || guestApi(pathname, req.method)) return NextResponse.next();
  const role = req.cookies.get('twin_role')?.value;
  if (role === `host:${ADMIN}`) return NextResponse.next();
  if (TECH && role === `tech:${TECH}` && techAllowed(pathname, req.method)) return NextResponse.next();
  if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'Sign-in required' }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = '/signin';
  url.search = `?next=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(url);
}
