# Requirements traceability

The PoC brief is the Confluence page "AI-Powered 3D Hotel Digital Twin and Smart Room Experience". This table
maps each part of it to where it is built, how it is checked and what is still simulated. "Sim" means the
simulated device platform in `web/lib/sim`; real SmartThings devices replace it per device once linked on
`/integrations`.

| Brief | Requirement | Where it is built | How it is checked | Limits |
|---|---|---|---|---|
| §3 Roles | Host, technician and guest see different things | `web/proxy.ts` (ADMIN_KEY / TECH_KEY sign-in on `/signin`, guest allowlist), `/api/guest/<token>/…` | sign-in roles run on a second server with keys set | Keys, not user accounts |
| §4A Floor to 3D | Any plan becomes a 3D floor with rooms, doors and furniture | `web/app/setup`, `web/lib/layout.ts`, `godot-renderer/scripts/floor_builder.gd`, `interior.gd` | walk test: every room reachable, routes through doorways | Plan reading is approximate; the editor corrects it |
| §4A Furniture | Host adds, moves, turns, removes furniture | `web/lib/sim/hotel.ts` (FURNITURE), `/api/furniture`, `components/RoomFurniture.tsx`; the renderer rebuilds in place | furniture API test; walkability check refuses blocking pieces | Box models for the catalogue |
| §4A Real room | The SmartThings Experience Zone looks like the real room, with its devices under their SmartThings app names (link by name) | `web/lib/sim/stzone.ts`, `floor_builder.gd` (zone finish), `interior.gd` (sofa, TV unit, lamps, bookcase…) | fx shots of the zone, map and walk views | Proportions from photos, not a survey |
| §4B Devices | Drag and drop SmartThings devices; they snap to where they are installed | `godot-renderer/scripts/placer.gd`, `/api/devices` | place test (21 devices) | |
| §4C Twin | Device opens into its components with flows and live data | `detail_view.gd`, `web/lib/sim/engine.ts` | smoke test, faults test (207 combinations) | Part shapes are primitives |
| §4D Faults | Realistic faults per type, visible where they happen, with repair steps | `engine.ts` (FAULT_DOCS), `device_fx.gd`, `piping.gd` | faults test | Synthetic data |
| §4E Hotel setup | Turn rooms into guest rooms with the usual devices | `hotel.ts` (setUpGuestRoom / setUpHotel) | hotel API test 16/16 | The fitted zone is never refurnished |
| §4F Capabilities | Offer only commands a device supports | `integrations/smartthings.ts` supported(), `guests.ts` guestCommands | mock SmartThings AC with modes cool/dry/auto only | |
| §4G Provenance | Show whether a value is simulated or reported by the device | DevicePanel source line, `runtime.ts` device().source | integration API test | |
| §4H Maintenance | Alerts to technicians, assignment, investigation records, history | `maintenance.ts`, `/tech`, `/api/technicians` | tech console in the browser | Browser notifications only |
| §5 Guest flow 1–3 | Host makes a time-limited QR with optional PIN for one ready room | `components/GuestQr.tsx`, `/api/guest`, `guests.ts` createPass (refuses rooms without devices) | guest test, hotel API test | |
| §5 Guest flow 4–5 | Guest walks from the entrance to the room in 3D, only rooms on the way open | `main.gd` _start_guest, `walk_nav.gd`, `walker.gd` (route, destination beacon) | guest test, walk test | |
| §5 Guest flow 6 | Guest sees and controls only their room's devices, within the pass's permissions | `guests.ts` (controls, acRange, hidden cameras) | guest API checks (403 outside the room) | |
| §5 Guest flow 7 | Controls in 3D; the room changes as devices change | `components/HoloControl.tsx`, bridge `track` / `preview` / `anchor`, `device_fx.gd` | browser test of the dial, beam and roller | |
| §5 Assistant | Typed or spoken requests in English or Bangla, plan then confirm | `agent-backend/app/guest_agent.py`, `GuestAssistant.tsx` | pytest | Rule-based without ANTHROPIC_API_KEY |
| §6 Door access | Unlock by policy with PIN step-up, rate limit, auto-relock, audit | `access.ts`, `dispatch.ts` | integration API test 20/20 | Real lock only through SmartThings |
| §6 Positioning | Live indoor position from RTLS, location QR codes, phone steps | `positioning.ts`, `Locator.tsx`, `/here/<cp>` | live test | RTLS feed simulated without hardware |
