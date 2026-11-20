import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** POST {role: host|tech, key}: sign in (sets the role cookie). DELETE: sign out. GET: whether sign-in is on. */
export async function GET() { return NextResponse.json({ required: !!process.env.ADMIN_KEY, technician: !!process.env.TECH_KEY }); }

export async function POST(req: NextRequest) {
  const { role, key } = await req.json().catch(() => ({}));
  const want = role === 'tech' ? process.env.TECH_KEY : process.env.ADMIN_KEY;
  if (!want || key !== want) return NextResponse.json({ error: 'Wrong key' }, { status: 401 });
  const res = NextResponse.json({ ok: true, home: role === 'tech' ? '/tech' : '/' });
  res.cookies.set('twin_role', `${role === 'tech' ? 'tech' : 'host'}:${key}`, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 12 });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete('twin_role');
  return res;
}
