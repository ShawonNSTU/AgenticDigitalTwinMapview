import { NextRequest } from 'next/server';
import { staffOwner } from '@/lib/chatlog';
import { oneFor } from '@/lib/chatroutes';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };
const go = async (req: NextRequest, ctx: Ctx) => oneFor(staffOwner(req.cookies.get('twin_role')?.value), (await ctx.params).id, req.method, req);
/** One saved conversation of the signed-in staff member: open, save, rename, delete (lib/chatroutes.ts). */
export { go as GET, go as PUT, go as PATCH, go as DELETE };
