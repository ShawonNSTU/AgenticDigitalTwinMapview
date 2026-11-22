import { NextRequest } from 'next/server';
import { staffOwner } from '@/lib/chatlog';
import { listFor } from '@/lib/chatroutes';

export const dynamic = 'force-dynamic';

/** GET: the signed-in staff member's saved assistant conversations (lib/chatroutes.ts). */
export function GET(req: NextRequest) { return listFor(staffOwner(req.cookies.get('twin_role')?.value)); }
