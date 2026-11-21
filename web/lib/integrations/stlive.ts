// Live link between the SmartThings Experience Zone's twin and its real devices.
//
// As soon as a SmartThings token is set (SMARTTHINGS_TOKEN in web/.env, or /integrations), every twin device in the
// zone that carries the label of one of the zone's real devices (lib/integrations/zone-devices.ts) is linked to
// that device's deviceId, with the capabilities it really has; no account listing or name matching is needed. The
// links are checked again before every polling round, so they follow the zone when the floor is rebuilt (new twin
// ids) and links to removed twin devices are dropped.
//
// Polling (lib/integrations/smartthings.ts) reads every linked device's status every SMARTTHINGS_POLL_MS (2 s by
// default, one batched request when the API allows it), so a change made in the SmartThings app, by a switch on
// the wall or by an automation shows on the 3D twin within about one round plus the renderer's 1 s poll.
import * as ST from './smartthings';
import { DEV, byId } from '@/lib/sim/engine';
import { zoneDeviceByLabel } from './zone-devices';

export const ZONE = 'smartthings-experience-zone';
const nameOf = (d: { name: string }) => String(d.name).split(' · ')[0];

/** Link the zone's twin devices to the real devices by deviceId. Returns the twin ids newly linked. */
export function linkZone(): string[] {
  if (!ST.configured()) return [];
  const done: string[] = [];
  for (const d of DEV as any[]) {
    if (d.room !== ZONE) continue;
    const z = zoneDeviceByLabel(nameOf(d));
    if (!z) continue;
    if (ST.link(d.id)?.stId === z.stId) continue;
    // the same real device linked to an older twin device (the zone was rebuilt): move the link
    for (const l of ST.links()) if (l.stId === z.stId && l.localId !== d.id) ST.unlink(l.localId);
    ST.setLink({ localId: d.id, stId: z.stId, component: 'main', label: z.label, type: d.type, capabilities: z.capabilities });
    done.push(d.id);
  }
  for (const l of ST.links()) if (!byId[l.localId]) ST.unlink(l.localId);
  return done;
}

/** Start keeping the linked devices live (no-op without a token, and when already running). */
export function ensureLive() {
  if (!ST.configured()) return;
  ST.startPolling(linkZone);
}
