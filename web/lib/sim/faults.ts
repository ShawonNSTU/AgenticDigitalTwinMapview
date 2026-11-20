// @ts-nocheck
// Fault simulation for technicians: a catalogue of realistic faults per device type.
//
// A fault changes the device's readings (scaled by severity 0..1), marks the components it damages, and comes with
// a diagnosis (evidence from the live readings) and repair steps tied to components. Everything downstream follows
// from the readings: part health, the device's health on the map, the flows in the 3D twin (a part in fault stops
// the flows through it), part animations (dirt on a filter, frost on a coil, a vibrating motor, a puddle) and the
// guided troubleshooting in the side panel.
//
// Hooks: base(r, s) edits the base readings before the derived ones are computed (so derived values follow);
// post(r, s) edits the full readings afterwards. parts: component key -> weight; the part shows watch from
// weight × severity ≥ 0.25 and fault from ≥ 0.6.

export type Step = { t: string; p: string };
export type Fault = {
  key: string; name: string; what: string;
  parts: Record<string, number>;
  base?: (r: any, s: number) => void;
  post?: (r: any, s: number) => void;
  title: string; conf: string; ev: (r: any, s: number) => string[]; steps: Step[];
};

const f1 = (v: number) => (+v).toFixed(1);
const f0 = (v: number) => (+v).toFixed(0);

const batteryLow = (cell = 'battery'): Fault => ({
  key: 'battery', name: 'Battery running out', what: 'The battery drains faster than expected; the device will drop offline when it runs out.',
  parts: { batt: 1 }, base: (r, s) => { r.batt = Math.round(70 - 64 * s); },
  title: 'Battery low', conf: 'Confirmed by device · battery report',
  ev: r => [`Battery at ${r.batt} %`, r.batt < 10 ? 'Below 10 %: reports may stop at any time' : 'Reports still arriving normally'],
  steps: [{ t: 'Open the battery cover', p: 'batt' }, { t: `Replace the ${cell}`, p: 'batt' }, { t: 'Trigger the device and check a fresh report arrives', p: 'batt' }],
});
const weakSignal = (part = 'radio'): Fault => ({
  key: 'signal', name: 'Weak wireless signal', what: 'The radio link to the hub degrades (obstruction, interference or distance); reports arrive late or not at all.',
  parts: { [part]: 1 }, base: (r, s) => { r.rssi = Math.round(-58 - 36 * s); },
  title: 'Wireless signal weak', conf: 'Confirmed by device · signal strength report',
  ev: r => [`Signal ${r.rssi} dBm (good is above -70)`, r.rssi < -85 ? 'Packets are being lost' : 'Reports delayed'],
  steps: [{ t: 'Check the radio module and antenna for damage', p: part }, { t: 'Move the hub or add a repeater closer to this room', p: part }, { t: 'Confirm the signal is above -70 dBm', p: part }],
});

export const FAULTS: Record<string, Fault[]> = {
  ac: [
    { key: 'filter', name: 'Clogged air filter', what: 'Dust blocks the filter: airflow falls, the fan speeds up to compensate and the coil runs cold enough to ice.',
      parts: { filter: 1, coil: 0.6, fan: 0.5 },
      base: (r, s) => { r.air = 100 - 60 * s; r.fan = Math.min(100, 55 + 45 * s); r.evIn = 7 - 6 * s; r.evOut = 12 - 8 * s; r.room += 3.5 * s; },
      title: 'Airflow blocked: air filter clogged', conf: 'Inferred · there is no filter sensor, but airflow, fan speed and coil temperature agree',
      ev: r => [`Airflow ${f0(r.air)} % of rated`, `Fan at ${f0(r.fan)} % to compensate`, `Coil inlet ${f1(r.evIn)} °C${r.evIn < 3 ? ', icing risk' : ''}`, `Room ${f1(r.room)} °C, set point ${r.set} °C not reached`],
      steps: [{ t: 'Switch to fan-only for 10 minutes so ice on the coil melts', p: 'coil' }, { t: 'Lift the front panel and slide out the air filter', p: 'filter' }, { t: 'Wash the filter in lukewarm water, dry it and refit', p: 'filter' }, { t: 'Check airflow and fan speed return to normal', p: 'fan' }] },
    { key: 'refrigerant', name: 'Refrigerant undercharge (leak)', what: 'Refrigerant escapes at a joint: the coil starves, superheat rises, the expansion valve opens fully and the room is not cooled.',
      parts: { eevin: 1, gassens: 0.8, coil: 0.7 },
      base: (r, s) => { r.evIn += 4 * s; r.evOut += 11 * s; r.room += 3 * s; r.fan = Math.min(100, r.fan + 20 * s); },
      post: (r, s) => { r.liq += 4 * s; },
      title: 'Refrigerant shortage in this indoor unit', conf: 'Likely · superheat, valve opening and gas-pipe temperature agree; the leak point is not measured',
      ev: r => [`Superheat ${f1(r.sh)} K (normal 4 to 7)`, `Expansion valve ${r.eevIn} steps open`, `Gas pipe ${f1(r.gas)} °C, warmer than the coil should allow`, `Room ${f1(r.room)} °C against set ${r.set} °C`],
      steps: [{ t: 'Read the gas-pipe temperature and pressure at the service port', p: 'gassens' }, { t: 'Check the expansion valve is not stuck and opens fully', p: 'eevin' }, { t: 'Leak-test the flare joints at the liquid and gas pipes', p: 'liqsens' }, { t: 'Repair, vacuum, recharge by weight; check superheat back to 4 to 7 K', p: 'coil' }] },
    { key: 'bearing', name: 'Fan motor bearing wear', what: 'Worn bearings add friction: the motor draws more current, vibrates and the fan slows.',
      parts: { motor: 1, fan: 0.6 },
      base: (r, s) => { r.amps *= 1 + 1.8 * s; r.air = 100 - 25 * s; },
      post: (r, s) => { r.vib = s; },
      title: 'Fan motor overloaded: bearings worn', conf: 'Likely · motor current and airflow agree; vibration is inferred',
      ev: r => [`Motor current ${r.amps.toFixed(2)} A (normal about 0.40)`, `Airflow ${f0(r.air)} % at the same fan setting`, 'Humming and rattling reported at speed'],
      steps: [{ t: 'Isolate power at the terminal block', p: 'psu' }, { t: 'Remove the front panel; turn the fan by hand and feel for drag', p: 'fan' }, { t: 'Replace the fan motor (bearings are not serviceable)', p: 'motor' }, { t: 'Run at high speed and check the current is back near 0.40 A', p: 'motor' }] },
    { key: 'drain', name: 'Blocked condensate drain', what: 'Slime blocks the drain hose: water backs up in the pan, the float switch trips and the unit stops cooling.',
      parts: { drain: 1, pcb: 0.6 },
      base: (r, s) => { r.drain = s >= 0.6 ? 'Overflowing · float switch open' : 'Slow · water backing up'; if (s >= 0.6) { r.err = 'Drain / float switch error (mock code)'; r.room += 3 * s; } },
      title: 'Condensate drain blocked', conf: 'Confirmed by device · float switch error',
      ev: r => [`Drain pan: ${r.drain}`, r.err ? `Error: ${r.err}` : 'No error yet', 'Water may drip from the indoor unit'],
      steps: [{ t: 'Switch the unit off and put a towel under it', p: 'psu' }, { t: 'Clear the drain hose with a wet vacuum or a drain pump', p: 'drain' }, { t: 'Clean the drain pan and pour water in to check it runs away', p: 'drain' }, { t: 'Restart and confirm the error clears', p: 'pcb' }] },
    { key: 'roomsensor', name: 'Room temperature sensor drift', what: 'The return-air sensor reads low, so the unit thinks the room is cool and throttles back while people feel warm.',
      parts: { roomsens: 1, display: 0.4 },
      base: (r, s) => { r.room -= 4 * s; r.fan = Math.max(20, r.fan - 25 * s); },
      title: 'Room temperature sensor reads low', conf: 'Likely · the sensor disagrees with the coil and supply-air temperatures',
      ev: r => [`Sensor says ${f1(r.room)} °C`, `Supply air ${f1(r.supply)} °C and coil ${f1(r.evIn)} °C suggest a warmer room`, `Fan throttled to ${f0(r.fan)} %`],
      steps: [{ t: 'Measure the room with a calibrated thermometer', p: 'roomsens' }, { t: 'Check the sensor plug on the control board', p: 'pcb' }, { t: 'Replace the room sensor (thermistor)', p: 'roomsens' }, { t: 'Confirm the reading matches the thermometer', p: 'display' }] },
    weakSignal('wifi'),
  ],
  odu: [
    { key: 'refrigerant', name: 'Refrigerant leak (system)', what: 'The circuit loses refrigerant: suction pressure falls, the compressor runs hot and fast, valves open wide.',
      parts: { svc: 0.6, rec: 0.6 },
      base: (r, s) => { r.dis += 34 * s; r.suc += 7 * s; r.lp -= 2.6 * s; r.hp -= 3 * s; r.hz += 30 * s; r.eev = Math.round(r.eev + 180 * s); },
      title: 'Refrigerant shortage: leak in the circuit', conf: 'Likely · four readings agree; the leak point is not measured',
      ev: r => [`Discharge ${f1(r.dis)} °C (normal under 100)`, `Low pressure ${f1(r.lp)} kgf/cm² and falling`, `Compressor at ${f0(r.hz)} Hz to keep up`, `Expansion valves ${r.eev} steps open`],
      steps: [{ t: 'Confirm low pressure on the gauge port', p: 'lp' }, { t: 'Check the expansion valves open fully to the far rooms', p: 'eev' }, { t: 'Leak-test service valves and joints', p: 'svc' }, { t: 'Repair, vacuum and recharge; watch discharge temperature drop', p: 'comp' }] },
    { key: 'coil', name: 'Fouled outdoor coil', what: 'Dirt and leaves on the condenser coil stop it shedding heat: head pressure and discharge temperature climb, efficiency drops.',
      parts: { coil: 1, hp: 0.6, fans: 0.4 },
      base: (r, s) => { r.hp += 7 * s; r.dis += 22 * s; r.fan = Math.round(r.fan + 14 * s); r.hz += 10 * s; },
      post: (r, s) => { r.liq += 6 * s; r.kw = +(r.kw * (1 + 0.3 * s)).toFixed(2); r.cop = +(r.cap / r.kw).toFixed(2); r.coilNote = s >= 0.6 ? 'fouled · leaves and dirt' : 'dusty'; },
      title: 'Condenser coil fouled: heat not rejected', conf: 'Likely · high pressure, discharge temperature and efficiency agree',
      ev: r => [`High pressure ${f1(r.hp)} kgf/cm²`, `Discharge ${f1(r.dis)} °C`, `Efficiency COP ${r.cop}`, `Fan pushed to step ${r.fan}`],
      steps: [{ t: 'Isolate the outdoor unit', p: 'inv' }, { t: 'Inspect the coil fins for leaves and dirt', p: 'coil' }, { t: 'Wash the coil from inside out with low-pressure water and coil cleaner', p: 'coil' }, { t: 'Restart; check high pressure and discharge temperature fall', p: 'hp' }] },
    { key: 'fan', name: 'Outdoor fan motor failure', what: 'The fan motor stops: no air through the coil, pressure and temperature rise until the unit protects itself.',
      parts: { fans: 1, coil: 0.6, hp: 0.6 },
      base: (r, s) => { r.fan = Math.round(r.fan * (1 - s)); r.hp += 9 * s; r.dis += 28 * s; },
      post: (r, s) => { r.liq += 8 * s; r.coilNote = 'no airflow'; },
      title: 'Outdoor fan not turning', conf: 'Confirmed by device · fan feedback is zero',
      ev: r => [`Fan step ${r.fan}`, `High pressure ${f1(r.hp)} kgf/cm²`, `Discharge ${f1(r.dis)} °C`],
      steps: [{ t: 'Isolate the unit and wait for the DC link to discharge', p: 'pfc' }, { t: 'Spin the fan by hand; check for a seized bearing or debris', p: 'fans' }, { t: 'Measure the motor winding and the drive output on the inverter board', p: 'inv' }, { t: 'Replace the motor; check pressure returns to normal', p: 'hp' }] },
    { key: 'inverter', name: 'Inverter board overcurrent trip', what: 'A failing power stage trips on overcurrent: the compressor stops and restarts, then locks out.',
      parts: { inv: 1, pfc: 0.8, comp: 0.5 },
      base: (r, s) => { if (s >= 0.6) { r.hz = 0; r.dis = 45; } else r.hz = Math.max(20, r.hz * (1 - 0.5 * s)); },
      post: (r, s) => { r.dcv = Math.round(r.dcv - 120 * s); r.invErr = s >= 0.6 ? 'Overcurrent trip · locked out (mock code)' : 'Overcurrent retries'; },
      title: 'Inverter tripped on overcurrent', conf: 'Confirmed by device · inverter error and DC link low',
      ev: r => [`Compressor ${r.hz ? `${f0(r.hz)} Hz, unstable` : 'stopped'}`, `DC link ${r.dcv} V (normal about 540)`, 'Indoor units are not cooled while it is locked out'],
      steps: [{ t: 'Isolate and wait 10 minutes for capacitors to discharge', p: 'pfc' }, { t: 'Check the DC link capacitors and reactor', p: 'pfc' }, { t: 'Megger the compressor windings before replacing the board', p: 'comp' }, { t: 'Replace the inverter board; check the compressor ramps up smoothly', p: 'inv' }] },
  ],
  fridge: [
    { key: 'door', name: 'Door left ajar', what: 'Warm air keeps getting in: the compressor runs non-stop and the fridge warms.',
      parts: { door: 1, ftemp: 0.5 },
      base: (r, s) => { if (s > 0.2) r.door = 'Open'; r.fz += 6 * s; r.fr += 4 * s; r.comp = 'Running'; },
      title: 'Door not closed', conf: 'Confirmed by device · door switch',
      ev: r => [`Door switch: ${r.door}`, `Fridge ${f1(r.fz)} °C (keep under 5)`, 'Compressor running without a break'],
      steps: [{ t: 'Close the door and check nothing blocks it', p: 'door' }, { t: 'Check the door gasket seals all round', p: 'door' }, { t: 'Watch the fridge temperature fall back under 5 °C', p: 'ftemp' }] },
    { key: 'defrost', name: 'Defrost heater failure', what: 'The defrost heater is open circuit: the evaporator ices up, airflow to the compartments stops and they warm.',
      parts: { defrost: 1, evap: 0.8, efan: 0.5 },
      base: (r, s) => { r.fr += 9 * s; r.fz += 4 * s; },
      post: (r, s) => { r.efan = Math.round(r.efan * (1 - 0.7 * s)); r.defrost = 'Off · heater open circuit'; r.evapNote = s >= 0.6 ? 'Iced solid' : 'Frosting'; },
      title: 'Evaporator iced: defrost not working', conf: 'Likely · freezer warming with the compressor running, heater shows no current',
      ev: r => [`Freezer ${f1(r.fr)} °C (keep under -15)`, `Evaporator fan ${r.efan} rpm, blocked by ice`, 'Defrost heater draws no current'],
      steps: [{ t: 'Unplug and remove the back panel of the freezer', p: 'evap' }, { t: 'Check the defrost heater for continuity', p: 'defrost' }, { t: 'Replace the heater and melt the ice', p: 'defrost' }, { t: 'Check the evaporator fan runs freely', p: 'efan' }] },
    { key: 'condfan', name: 'Condenser fan failure', what: 'The condenser fan stops: the compressor overheats and cooling slows.',
      parts: { cfan: 1, cond: 0.7, comp: 0.5 },
      base: (r, s) => { r.fz += 2 * s; r.fr += 3 * s; r.comp = 'Running'; },
      post: (r, s) => { r.cfan = s >= 0.5 ? 0 : Math.round(r.cfan * (1 - s)); r.condT += 15 * s; r.condNote = `Hot · ${Math.round(r.condT)} °C`; },
      title: 'Condenser fan stopped', conf: 'Confirmed by device · fan feedback is zero',
      ev: r => [`Condenser fan ${r.cfan} rpm`, `Condenser ${f0(r.condT)} °C`, `Freezer ${f1(r.fr)} °C`],
      steps: [{ t: 'Unplug and open the rear cover', p: 'cond' }, { t: 'Clear dust and check the fan blade turns', p: 'cfan' }, { t: 'Replace the fan motor', p: 'cfan' }, { t: 'Check the compressor cycles normally again', p: 'comp' }] },
  ],
  washer: [
    { key: 'drain', name: 'Drain pump blocked', what: 'A sock or coin jams the pump: water cannot drain and the cycle stops with a drain error.',
      parts: { pump: 1, level: 0.6 },
      base: (r, s) => { r.pump = 0; r.level = 'High (not draining)'; r.lockd = 'Locked'; if (s >= 0.5) { r.err = 'Drain error (mock code)'; r.state = 'Stopped · drain error'; r.motor = 0; } else { r.state = 'Draining (slow)'; r.motor = 0; } },
      title: 'Washer cannot drain: pump blocked', conf: 'Confirmed by sensor · pump current 0 A and the level stays high',
      ev: r => [`Drain pump ${r.pump.toFixed(2)} A`, `Water level: ${r.level}`, r.err ? `Error: ${r.err}` : 'Cycle slowing'],
      steps: [{ t: 'Switch off and put towels down', p: 'dlock' }, { t: 'Open the filter cap at the bottom front and drain the water', p: 'pump' }, { t: 'Remove debris from the pump filter and check the impeller turns', p: 'pump' }, { t: 'Run drain-and-spin; the level sensor should read empty', p: 'level' }] },
    { key: 'inlet', name: 'Water inlet valve stuck', what: 'The inlet valve does not open: the drum stays empty and the cycle stops with a water supply error.',
      parts: { valve: 1, flow: 0.6 },
      base: (r, s) => { r.valve = 'Closed'; r.level = 'Empty'; r.state = s >= 0.5 ? 'Stopped · no water' : 'Filling (slow)'; r.motor = 0; if (s >= 0.5) r.err = 'Water supply error (mock code)'; },
      post: r => { r.flow = 0; },
      title: 'No water coming in', conf: 'Confirmed by sensor · flow meter reads zero while filling',
      ev: r => [`Flow ${r.flow} L/min while filling`, `Water level: ${r.level}`, r.err ? `Error: ${r.err}` : 'Fill taking too long'],
      steps: [{ t: 'Check the tap is open and the hose is not kinked', p: 'flow' }, { t: 'Clean the mesh filter at the inlet', p: 'valve' }, { t: 'Measure the valve coil; replace the valve if open circuit', p: 'valve' }, { t: 'Start a rinse and check water flows in', p: 'flow' }] },
    { key: 'bearing', name: 'Drum bearing wear', what: 'Worn drum bearings rumble and vibrate in spin; the motor works harder.',
      parts: { drum: 1, motor: 0.6 },
      base: r => { r.state = 'Washing (spin test)'; r.motor = 1000; r.lockd = 'Locked'; },
      post: (r, s) => { r.vib = s; r.w = Math.round(320 + 400 * s); },
      title: 'Drum bearings worn', conf: 'Likely · power and vibration during spin are above normal',
      ev: r => [`Spin ${r.motor} rpm drawing ${r.w} W`, 'Loud rumble in spin', 'Drum has play when rocked by hand'],
      steps: [{ t: 'Rock the empty drum up and down; feel for play', p: 'drum' }, { t: 'Check the shock absorbers and counterweights', p: 'drum' }, { t: 'Replace the bearings and seal (rear tub)', p: 'drum' }, { t: 'Run a spin and check power is back near 300 W', p: 'motor' }] },
  ],
  dryer: [
    { key: 'lint', name: 'Lint filter and duct blocked', what: 'Lint blocks the airflow: the drum overheats, drying takes longer and the thermal cut-off may trip.',
      parts: { lint: 1, fan: 0.5, tco: 0.6, temp: 0.5 },
      base: (r, s) => { r.state = 'Drying'; r.heat = 'On'; r.lint = s >= 0.5 ? 'Blocked' : 'Clogging'; r.temp = Math.round(62 + 40 * s); },
      post: (r, s) => { r.inlet = Math.round(118 + 30 * s); r.fanrpm = Math.round(2750 * (1 - 0.5 * s)); },
      title: 'Airflow blocked: lint filter and duct', conf: 'Likely · exhaust temperature high and fan slowed',
      ev: r => [`Exhaust ${r.temp} °C (normal about 62)`, `Heater inlet ${r.inlet} °C`, `Blower ${r.fanrpm} rpm`],
      steps: [{ t: 'Pull out and clean the lint filter', p: 'lint' }, { t: 'Clean the duct behind the filter', p: 'fan' }, { t: 'Check the thermal cut-off has not tripped', p: 'tco' }, { t: 'Run and check exhaust back near 62 °C', p: 'temp' }] },
    { key: 'heater', name: 'Heater element open circuit', what: 'The heater coil breaks: the drum turns but stays cold and clothes do not dry.',
      parts: { heat: 1, tco: 0.4 },
      base: r => { r.state = 'Drying'; r.heat = 'Off · open circuit'; r.temp = 30; },
      post: r => { r.inlet = 30; r.moist = 60; },
      title: 'Heater not heating', conf: 'Likely · drum turning, no temperature rise',
      ev: r => [`Inlet ${r.inlet} °C with heat requested`, `Moisture still ${r.moist} %`],
      steps: [{ t: 'Unplug and open the rear panel', p: 'heat' }, { t: 'Check the heater coil for continuity', p: 'heat' }, { t: 'Check the thermal cut-off', p: 'tco' }, { t: 'Replace the heater and run a test cycle', p: 'heat' }] },
  ],
  oven: [
    { key: 'element', name: 'Heating element open circuit', what: 'The bottom element fails: the oven heats slowly or not at all.',
      parts: { elem: 1, relay: 0.5 },
      base: (r, s) => { r.on = true; r.temp = Math.round(180 - 140 * s); },
      title: 'Oven not reaching temperature', conf: 'Likely · element on, cavity stays cool',
      ev: r => [`Cavity ${r.temp} °C, set 180 °C`, 'Element requested on for 20 min'],
      steps: [{ t: 'Isolate the oven', p: 'relay' }, { t: 'Check the element for continuity', p: 'elem' }, { t: 'Replace the element', p: 'elem' }, { t: 'Preheat and check it reaches 180 °C', p: 'probe' }] },
    { key: 'fan', name: 'Convection fan seized', what: 'The convection fan stops: heat is uneven and the element can overheat.',
      parts: { fan: 1, elem: 0.4 },
      base: r => { r.on = true; r.temp = 180; },
      post: (r, s) => { r.cool = Math.round(2200 * (1 - 0.3 * s)); r.fanNote = s >= 0.6 ? 'Seized' : 'Sticking'; },
      title: 'Convection fan not turning', conf: 'Likely · uneven cavity temperature',
      ev: () => ['Hot spots near the element', 'No fan noise in fan mode'],
      steps: [{ t: 'Isolate and remove the back panel inside the cavity', p: 'fan' }, { t: 'Turn the fan by hand; replace the motor if seized', p: 'fan' }, { t: 'Check even heating', p: 'probe' }] },
  ],
  light: [
    { key: 'driver', name: 'LED driver overheating', what: 'The driver runs hot (poor ventilation or failing capacitors): the light flickers and dims to protect itself.',
      parts: { driver: 1, sink: 0.7, ntc: 0.5 },
      base: (r, s) => { r.lv = Math.max(20, (r.lv || 70) - 35 * s); r.ledT += 45 * s; r.ma = r.lv * 4.1 * (1 + 0.2 * s); },
      title: 'LED driver overheating', conf: 'Confirmed by device · LED temperature sensor',
      ev: r => [`LED temperature ${f0(r.ledT)} °C (limit 70)`, `Dimmed to ${f0(r.lv)} %`, 'Flicker reported'],
      steps: [{ t: 'Switch off at the circuit breaker', p: 'driver' }, { t: 'Check the heat sink has air around it', p: 'sink' }, { t: 'Replace the LED driver', p: 'driver' }, { t: 'Switch on and check the temperature settles under 60 °C', p: 'ntc' }] },
    { key: 'led', name: 'LED board failure', what: 'A string of LEDs fails open: the light is dark or patchy.',
      parts: { led: 1 },
      base: r => { r.lv = 0; r.ma = 0; },
      title: 'LED board not lighting', conf: 'Confirmed by device · zero LED current while on',
      ev: () => ['Light on, LED current 0 mA'],
      steps: [{ t: 'Switch off at the breaker', p: 'driver' }, { t: 'Replace the LED board', p: 'led' }, { t: 'Switch on and check brightness', p: 'led' }] },
    weakSignal('radio'),
  ],
  tv: [
    { key: 'psu', name: 'Power supply failure', what: 'The power board fails: the TV will not wake from standby.',
      parts: { psu: 1, main: 0.4 }, base: r => { r.on = false; r.w = 0; }, post: r => { r.mainNote = 'No power'; },
      title: 'TV does not power on', conf: 'Likely · no power draw in standby or on',
      ev: () => ['Power draw 0 W', 'Standby light off'],
      steps: [{ t: 'Unplug and remove the back cover', p: 'psu' }, { t: 'Check the fuse and capacitors on the power board', p: 'psu' }, { t: 'Replace the power board', p: 'psu' }] },
    { key: 'backlight', name: 'Backlight failure', what: 'The LED backlight fails: sound works but the picture is dark.',
      parts: { bl: 1, panel: 0.5 }, base: r => { r.on = true; r.w = 40; }, post: r => { r.nits = 0; },
      title: 'Picture dark, sound working', conf: 'Likely · power draw low for an on TV',
      ev: r => [`Power ${r.w} W (normal about 112)`, 'Picture visible only with a torch'],
      steps: [{ t: 'Shine a torch at the screen to confirm the picture is there', p: 'panel' }, { t: 'Open the panel and check the LED strips', p: 'bl' }, { t: 'Replace the backlight strips', p: 'bl' }] },
    weakSignal('wifi'),
  ],
  speaker: [
    { key: 'amp', name: 'Amplifier fault', what: 'The amplifier distorts and cuts out at volume.', parts: { amp: 1, woofer: 0.5 },
      post: (r, s) => { r.w = +(r.w * (1 + 2 * s)).toFixed(1); r.ampNote = 'Clipping · distorting'; },
      title: 'Amplifier distorting', conf: 'Likely · power draw high, distortion reported', ev: r => [`Power ${r.w} W`, 'Distortion at medium volume'],
      steps: [{ t: 'Play a test tone', p: 'woofer' }, { t: 'Replace the amplifier board', p: 'amp' }] },
    weakSignal('wifi'),
  ],
  blinds: [
    { key: 'motor', name: 'Tube motor stall', what: 'The motor stalls against a jam and the blind stops half way.', parts: { motor: 1, gear: 0.6 },
      base: r => { r.pos = 45; }, post: r => { r.moving = false; },
      title: 'Blind stuck half way', conf: 'Confirmed by device · motor stall', ev: r => [`Position ${r.pos} %`, 'Motor stalled on the last command'],
      steps: [{ t: 'Check the fabric is not caught', p: 'motor' }, { t: 'Check the gearbox turns', p: 'gear' }, { t: 'Re-set the end limits', p: 'motor' }] },
    batteryLow('battery pack'), weakSignal('radio'),
  ],
  camera: [
    { key: 'storage', name: 'Storage full', what: 'The memory card fills up: recording stops.', parts: { sd: 1 },
      post: (r, s) => { r.storage = Math.round(85 + 15 * s); if (s >= 0.6) r.kbps = 0; },
      title: 'Recording stopped: storage full', conf: 'Confirmed by device', ev: r => [`Storage ${r.storage} % used`, r.kbps ? 'Still recording' : 'Recording stopped'],
      steps: [{ t: 'Turn on loop recording or clear old footage', p: 'sd' }, { t: 'Replace the card if it reports errors', p: 'sd' }] },
    { key: 'ir', name: 'Night-vision LEDs failed', what: 'The IR LEDs fail: night images are black.', parts: { ir: 1 }, post: r => { r.irNote = 'Not lighting'; },
      title: 'Night vision not working', conf: 'Likely · dark frames at night', ev: () => ['Night frames are black'],
      steps: [{ t: 'Cover the light sensor and check the IR LEDs glow', p: 'ir' }, { t: 'Replace the IR board', p: 'ir' }] },
    weakSignal('wifi'),
  ],
  doorbell: [batteryLow('battery'), weakSignal('wifi')],
  lock: [
    { key: 'bolt', name: 'Bolt jammed', what: 'The door is misaligned: the bolt cannot throw and the lock reports a jam.', parts: { bolt: 1, gear: 0.7 },
      base: r => { r.locked = false; },
      title: 'Lock jammed: bolt cannot throw', conf: 'Confirmed by device · motor stall on lock', ev: () => ['Bolt motor stalled while locking', 'Door left unlocked'],
      steps: [{ t: 'Check the door closes fully against the strike', p: 'bolt' }, { t: 'Adjust the strike plate', p: 'bolt' }, { t: 'Lock and unlock three times', p: 'gear' }] },
    batteryLow('4 AA batteries'), weakSignal('radio'),
  ],
  leak: [
    { key: 'water', name: 'Water detected', what: 'Water reaches the probes (a leak from a pipe or appliance nearby).', parts: { probe: 1, buzz: 0.5 },
      base: r => { r.wet = true; },
      title: 'Water on the floor', conf: 'Confirmed by sensor · probes are wet', ev: () => ['Probes wet', 'Buzzer sounding'],
      steps: [{ t: 'Find and stop the source of the water', p: 'probe' }, { t: 'Dry the area and the probes', p: 'probe' }, { t: 'Check the sensor reports dry again', p: 'buzz' }] },
    batteryLow('CR2032 cell'), weakSignal('radio'),
  ],
  temphum: [
    { key: 'drift', name: 'Humidity sensor drift', what: 'The humidity element ages and reads high.', parts: { hum: 1 },
      base: (r, s) => { r.hum = Math.round(55 + 38 * s); },
      title: 'Humidity reading implausible', conf: 'Likely · reading disagrees with nearby sensors', ev: r => [`Humidity ${r.hum} %`, 'Nearby sensors read about 55 %'],
      steps: [{ t: 'Compare with a reference hygrometer', p: 'hum' }, { t: 'Replace the sensor', p: 'hum' }] },
    batteryLow('CR2032 cell'), weakSignal('radio'),
  ],
  motion: [
    { key: 'lens', name: 'Lens obstructed', what: 'Something covers the lens: no motion is seen.', parts: { lens: 1, pir: 0.5 },
      base: r => { r.motion = false; }, post: r => { r.lensNote = 'Covered'; },
      title: 'No motion seen in an occupied room', conf: 'Likely · no events while the room is in use', ev: () => ['No motion events for 4 hours during office hours'],
      steps: [{ t: 'Check nothing covers the lens', p: 'lens' }, { t: 'Walk past and check an event arrives', p: 'pir' }] },
    batteryLow('CR123A cell'), weakSignal('radio'),
  ],
  plug: [
    { key: 'overload', name: 'Overload', what: 'The connected load draws more than the plug is rated for: the relay heats and the plug cuts out.', parts: { relay: 1, fuse: 0.7, meter: 0.4 },
      base: (r, s) => { r.w = Math.round(42 + 3300 * s); if (s >= 0.8) r.on = false; },
      title: 'Plug overloaded', conf: 'Confirmed by device · power meter', ev: r => [`Load ${r.w} W (rating 3000 W)`, r.on ? 'Still on' : 'Cut out to protect itself'],
      steps: [{ t: 'Unplug the load', p: 'relay' }, { t: 'Check the fuse', p: 'fuse' }, { t: 'Move the load to a dedicated socket', p: 'meter' }] },
    weakSignal('radio'),
  ],
  purifier: [
    { key: 'hepa', name: 'HEPA filter end of life', what: 'The HEPA filter is loaded: airflow falls and particles stay high.', parts: { hepa: 1, pm: 0.4 },
      base: (r, s) => { r.hepa = Math.round(62 - 60 * s); r.pm = Math.round(r.pm + 25 * s); },
      title: 'Replace the HEPA filter', conf: 'Confirmed by device · filter life', ev: r => [`Filter life ${r.hepa} %`, `PM2.5 ${r.pm} µg/m³`],
      steps: [{ t: 'Open the back cover', p: 'pre' }, { t: 'Replace the HEPA filter', p: 'hepa' }, { t: 'Reset the filter counter', p: 'pcb' }] },
    { key: 'fan', name: 'Fan motor failure', what: 'The BLDC motor fails: no air moves.', parts: { motor: 1, fan: 0.7 },
      base: r => { r.fan = 0; },
      title: 'Fan not turning', conf: 'Confirmed by device · motor feedback zero', ev: () => ['No airflow', 'Motor feedback 0 rpm'],
      steps: [{ t: 'Check the fan is not obstructed', p: 'fan' }, { t: 'Replace the motor', p: 'motor' }] },
  ],
  vacuum: [
    { key: 'brush', name: 'Brush roll jammed', what: 'Hair wraps the brush roll: it stalls and the robot stops with an error.', parts: { brush: 1, side: 0.4 },
      base: r => { r.state = 'Error · brush stuck'; },
      title: 'Brush roll jammed', conf: 'Confirmed by device · brush motor stall', ev: () => ['Brush motor stalled', 'Robot stopped mid-room'],
      steps: [{ t: 'Turn the robot over and remove the brush', p: 'brush' }, { t: 'Cut away hair and clean the bearings', p: 'brush' }, { t: 'Refit and resume', p: 'mcu' }] },
    { key: 'bin', name: 'Dust bin full', what: 'The bin is full: suction drops.', parts: { bin: 1, suction: 0.5 },
      base: (r, s) => { r.bin = Math.round(60 + 40 * s); },
      title: 'Empty the dust bin', conf: 'Confirmed by device', ev: r => [`Bin ${r.bin} % full`],
      steps: [{ t: 'Empty the bin', p: 'bin' }, { t: 'Tap out the filter', p: 'bin' }] },
    batteryLow('battery pack'),
  ],
};

export const LEVELS = [{ key: 'early', name: 'Early', s: 0.35 }, { key: 'developing', name: 'Developing', s: 0.65 }, { key: 'severe', name: 'Severe', s: 1 }];

/** How a part looks under a fault: watch from weight × severity ≥ 0.25, fault from ≥ 0.6. */
export function partHealthUnder(f: Fault | undefined, key: string, s: number): 'ok' | 'watch' | 'fault' {
  const w = f?.parts[key];
  if (!w || s <= 0) return 'ok';
  const v = w * s;
  return v >= 0.6 ? 'fault' : v >= 0.25 ? 'watch' : 'ok';
}
