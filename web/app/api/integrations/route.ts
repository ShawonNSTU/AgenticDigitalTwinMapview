import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import * as ST from '@/lib/integrations/smartthings';
import { syncAccount } from '@/lib/integrations/stsync';
import { ensureLive, linkZone } from '@/lib/integrations/stlive';
import { policy, setPolicy } from '@/lib/sim/access';

export const dynamic = 'force-dynamic';

/** GET: SmartThings connection and links, and the door-access policy.
 *  POST {token?, policy?}: connect (a token is checked against SmartThings and the account's devices are brought
 *  onto the map at once, see lib/integrations/stsync.ts), disconnect (empty token), change the policy. */
export async function GET() { ensureLive(); return NextResponse.json({ smartthings: ST.info(), lockPolicy: policy() }); }

export async function POST(req: NextRequest) {
  const p = z.object({ token: z.string().max(400).optional(), policy: z.object({ stepUpMinutes: z.number().min(0).max(1440), maxUnlocksPer10Min: z.number().min(1).max(100), autoRelockSec: z.number().min(0).max(3600) }).partial().optional() }).safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: p.error.message }, { status: 400 });
  if (p.data.policy) setPolicy(p.data.policy);
  let sync = null;
  if (p.data.token != null) {
    ST.setToken(p.data.token);
    if (p.data.token.trim()) {
      // the zone's devices are known by deviceId: link them first, then bring the rest of the account on
      linkZone();
      try { sync = await syncAccount(); ensureLive(); }
      catch (e) {
        ST.setToken('');   // a token SmartThings refuses is not kept
        return NextResponse.json({ error: `${(e as Error).message}. Check the token and its scopes (devices: read, execute; locations: read).`, smartthings: ST.info(), lockPolicy: policy() }, { status: 502 });
      }
    }
  }
  return NextResponse.json({ smartthings: ST.info(), lockPolicy: policy(), sync });
}
