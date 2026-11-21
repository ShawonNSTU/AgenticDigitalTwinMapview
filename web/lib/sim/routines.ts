// Routines: a named set of device commands for a room ("Movie night", "Good night", "Welcome"). Each routine says
// what every device TYPE does; a room runs it on the devices it has (a real SmartThings device gets the real
// command through dispatch; a guest only gets what the guest pass allows).
export type Cmd = { command: string; args?: Record<string, unknown> };
export type Routine = { id: string; name: string; about: string; steps: Record<string, Cmd[]> };

const on = { command: 'power', args: { on: 'true' } }, off = { command: 'power', args: { on: 'false' } };

export const ROUTINES: Routine[] = [
  { id: 'movie', name: 'Movie night', about: 'Dim warm lights, close the blinds, TV on',
    steps: { light: [{ command: 'setColorTemperature', args: { kelvin: 2700 } }, { command: 'setLevel', args: { percent: 15 } }], blinds: [{ command: 'close' }], tv: [on], speaker: [] } },
  { id: 'sleep', name: 'Good night', about: 'Lights, TV and fans off, blinds closed, AC 24 °C, purifier on low',
    steps: { light: [off], blinds: [{ command: 'close' }], tv: [off], fan: [off], ac: [{ command: 'setMode', args: { mode: 'cool' } }, { command: 'setTemperature', args: { celsius: 24 } }, { command: 'setFanSpeed', args: { percent: 30 } }], purifier: [{ command: 'setFan', args: { level: 1 } }] } },
  { id: 'morning', name: 'Good morning', about: 'Blinds open, bright neutral lights, TV off',
    steps: { light: [{ command: 'setColorTemperature', args: { kelvin: 4000 } }, { command: 'setLevel', args: { percent: 70 } }], blinds: [{ command: 'open' }], tv: [off] } },
  { id: 'welcome', name: 'Welcome', about: 'Lights on, blinds open, AC 24 °C',
    steps: { light: [{ command: 'setColorTemperature', args: { kelvin: 3500 } }, { command: 'setLevel', args: { percent: 80 } }], blinds: [{ command: 'open' }], ac: [{ command: 'setMode', args: { mode: 'cool' } }, { command: 'setTemperature', args: { celsius: 24 } }] } },
  { id: 'focus', name: 'Focus', about: 'Bright cool lights, blinds open, TV off',
    steps: { light: [{ command: 'setColorTemperature', args: { kelvin: 5000 } }, { command: 'setLevel', args: { percent: 100 } }], blinds: [{ command: 'open' }], tv: [off] } },
  { id: 'away', name: 'Away', about: 'Everything off, blinds closed',
    steps: { light: [off], tv: [off], fan: [off], purifier: [off], blinds: [{ command: 'close' }], ac: [off] } },
];
export const routineById = (id: string) => ROUTINES.find(r => r.id === id);
