// Door access for guests: the hotel's policy around unlocking, an audit log of every lock and unlock attempt,
// and automatic relocking. The lock itself is reached through the device integration layer (a real SmartThings
// lock when linked on /integrations, the simulator otherwise).
//
// Policy (adjustable on /integrations):
//   - only a guest whose pass allows unlocking, who verified the check-in PIN, on their own room's lock
//   - only during the stay (pass valid, not withdrawn)
//   - step-up: the PIN must be entered again for an unlock if the last entry is older than `stepUpMinutes`
//   - at most `maxUnlocksPer10Min` unlocks per pass in ten minutes
//   - the lock relocks itself `autoRelockSec` seconds after an unlock (0 = never)

export type Policy = { stepUpMinutes: number; maxUnlocksPer10Min: number; autoRelockSec: number };
export type Audit = { at: number; deviceId: string; room: string; action: 'lock' | 'unlock' | 'relock'; by: string; ok: boolean; reason: string; via: 'smartthings' | 'simulator' };

const g = globalThis as unknown as { __access?: { policy: Policy; audit: Audit[]; stepUp: Record<string, number>; timers: Record<string, ReturnType<typeof setTimeout>> } };
const A = (g.__access ??= { policy: { stepUpMinutes: 5, maxUnlocksPer10Min: 6, autoRelockSec: 15 }, audit: [], stepUp: {}, timers: {} });

export const policy = () => A.policy;
export function setPolicy(p: Partial<Policy>) {
  A.policy = { ...A.policy, ...Object.fromEntries(Object.entries(p).filter(([, v]) => typeof v === 'number' && v >= 0)) };
  return A.policy;
}
export function audit(entry: Omit<Audit, 'at'>) {
  A.audit.push({ ...entry, at: Date.now() });
  if (A.audit.length > 500) A.audit.shift();
}
export const auditLog = (deviceId?: string) => A.audit.filter(a => !deviceId || a.deviceId === deviceId).slice().reverse();

/** The guest entered the PIN just now (pass token). */
export const markStepUp = (token: string) => { A.stepUp[token] = Date.now(); };
export const stepUpFresh = (token: string) => Date.now() - (A.stepUp[token] ?? 0) <= A.policy.stepUpMinutes * 60_000;
export function unlocksRecently(by: string) {
  const since = Date.now() - 10 * 60_000;
  return A.audit.filter(a => a.by === by && a.action === 'unlock' && a.ok && a.at >= since).length;
}

/** Relock after the policy's delay (replaces a pending relock for the same lock). */
export function scheduleRelock(deviceId: string, relock: () => Promise<boolean>) {
  clearTimeout(A.timers[deviceId]);
  if (!A.policy.autoRelockSec) return;
  A.timers[deviceId] = setTimeout(async () => { await relock().catch(() => false); }, A.policy.autoRelockSec * 1000);
}
