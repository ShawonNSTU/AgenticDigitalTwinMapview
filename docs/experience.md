# Hotel experience on the 3D twin

The twin shows how the floor feels, what it uses and what is about to fail, live from the SmartThings devices
(real in the Experience Zone, simulated elsewhere). Each feature below starts from a story, a moment a guest or
the hotel lives through, and everything shown comes from the platform's live data, not from animation.

| # | Story | What happens | Where |
|---|---|---|---|
| 1 | **"The room knows you're coming"** | The guest says "on my way" (or walks from the lift in 3D, or the hotel's positioning sees them). The room is prepared in time: AC to their temperature, their light scene, the curtain where they like it, a welcome on the TV. In the Experience Zone the **real** SmartThings lights and roller shade move. The room turns *ready* when it reaches their temperature, and the TV greets them by name. | Guest page: *Your stay*. Admin: *Live ops → Guest arrivals*, room auras in 3D. |
| 4 | **"Light that feels real"** | Rendering adapts to the device: lite on phones, balanced in the browser, high or ultra on a showcase PC (Forward+: SDFGI, SSIL, SSR, volumetric fog). Auto mode follows the frame rate and never oscillates. Every piece of furniture stands on a soft contact shadow; colour grading tuned. | Map toolbar: quality selector. |
| 5 | **"Comfort you can see"** | A live field over each room's floor: cooler and warmer than the guest's target, cleaner air around the purifier, moving air out of the AC. A comfort score from thermal, air, light and sound (each labelled measured or estimated), with advice as concrete device commands. "Make it comfortable" runs them. | Toolbar *Comfort*. *Live ops → Comfort*. Guest: *Your stay*. Assistant: "make my room comfortable". |
| 6 | **"Every watt tells a story"** | Power flows from the distribution board to each room (dash speed and colour by load), a light pillar per device as tall as its draw, kWh, cost and CO2 today, and the energy the presence-aware eco avoided: guest out, checked out, back on the way. | Toolbar *Energy*. *Live ops → Energy*. Assistant: "how much energy did we use today?" |
| 7 | **"Fix it before the guest notices"** | Beacons over devices that need attention, and violet beacons over devices **predicted** to fail ("fails in 4 min"). One click sends the right technician: the route from the lift lobby is drawn and walked in 3D, and on arrival the x-ray opens at the failing part. Check-out triggers eco and housekeeping (the robot vacuum starts). | Technician console: *Predicted*. *Live ops → Predicted failures*. Assistant: "what will fail next?", "send a technician to AC-01". |

## A five-minute demo

1. **Admin** opens the map and *Live ops*. A guest is checked in to the Experience Zone (room card → *Guest QR code*).
2. **Guest** opens the link on a phone: *Your stay* shows *Checked in*. Set 22.5 °C, warm light, curtain 60 %. Tap
   *I'll be there in 5 min* (or let the 3D walk from the lift start).
3. Within the lead time (about 2.5 min per °C to close, 2-15 min) the room starts **preparing**: the welcome scene
   ticks off step by step, 17 of them on the zone's real SmartThings devices. The admin sees a toast and the
   room's amber aura; the temperature closes in on 22.5 °C; the journey turns **ready**, the TV says "Welcome, Ayesha".
4. Toggle **Comfort**: blue cool air spreads from the ceiling AC. Ask the assistant "is my room ready?".
5. Guest taps *I'm heading out*: the room goes to **eco**, and *Live ops → Energy* starts counting what it saves.
6. A **Degrading** fault on the purifier (device panel → Fault simulation): *Predicted failures* says the fan motor
   fails in about 4 min, with evidence and confidence. The technician clicks *Send me there*: the route draws
   from the lift lobby, the technician walks it, and the x-ray opens at the BLDC fan motor.
7. Front desk **checks the guest out**: curtain closes, AC off, housekeeping requested.

## How the numbers are made

- **Power**: a SmartThings `powerMeter` reading when the real device has one (shown as *metered*); otherwise a power
  model per device type driven by its live state (light level and fixture, AC load from room vs set point with an
  inverter curve, TV on, fan speed, vacuum cleaning or charging). ACs carry their share of the outdoor unit's
  compressor. Energy integrates on real time every 2 s and survives restarts (`web/.data/energy.json`).
- **Avoided energy**: while the automation holds a room in eco, what it drew before eco minus what it draws now.
  It stops when anyone changes a device in the room.
- **Comfort**: temperature from a real sensor, else the AC's room sensor, else a sensor in the room; PM2.5 from the
  purifier, else an assumed background; light and sound are estimated from what the devices do. The score weights
  thermal 40, air 25, light 20, sound 15.
- **Predictions**: a *Degrading* fault worsens on a known curve, so the time each component crosses the watch (0.25)
  and fault (0.6) lines is exact (confidence 85 %). Scenario faults follow the floor clock. An AC that runs for
  minutes without pulling the room toward its set point is flagged from the live trend. Batteries and filters use a
  typical wear rate (60 %).
- **Configuration**: `ENERGY_TARIFF_PER_KWH`, `ENERGY_CURRENCY`, `GRID_CO2_KG_PER_KWH` (or `PATCH /api/energy`),
  `DEGRADE_MINUTES`.

## Limits

- The web build uses WebGL 2 (Compatibility): no real-time global illumination there; *ultra* needs the desktop build.
- Light and sound comfort are estimates; add a lux or noise sensor and the comfort model can use it.
- Without a power meter on a device, its watts are modelled (the panel says so).
- Positioning-based ETAs need the hotel's RTLS or the guest's location codes (`/integrations`).
