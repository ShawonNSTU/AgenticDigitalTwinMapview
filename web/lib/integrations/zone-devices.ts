// The real devices of the 4th floor SmartThings Experience Zone (room 401), as they are in the zone's SmartThings
// account: label, deviceId and the commands each supports (docs/smartthings-zone-devices.md). The zone's twin
// devices carry these labels (lib/sim/stzone.ts) and are linked to these deviceIds as soon as a token is set
// (SMARTTHINGS_TOKEN in web/.env, or /integrations): no account listing or name matching is needed.

export type ZoneDevice = {
  label: string;
  stId: string;
  /** The twin's device type. */
  type: 'light' | 'blinds' | 'plug';
  /** SmartThings capabilities on the `main` component. */
  capabilities: string[];
};

const COLOR_BULB = ['switch', 'switchLevel', 'colorTemperature', 'colorControl'];
const SWITCH = ['switch'];
const SHADE = ['windowShade', 'windowShadeLevel'];

export const ZONE_DEVICES: ZoneDevice[] = [
  { label: 'Aqara Roller Shade Controller', stId: '77233c09-6de7-4903-a137-ea7bf1d301ae', type: 'blinds', capabilities: SHADE },
  { label: 'Blinds Switch', stId: '648ac2ca-a762-4fb1-91be-b8eba39b5c2c', type: 'plug', capabilities: SWITCH },
  { label: 'Desk Lamp', stId: '0f477ef7-8574-4be9-9bb3-f72ed5f719e6', type: 'light', capabilities: COLOR_BULB },
  { label: 'Left Window Light', stId: 'aaa3da5b-bbda-4b4e-90fc-ac11f0c6071c', type: 'light', capabilities: SWITCH },
  { label: 'Light 1', stId: 'ce885b72-4a0a-47c3-9549-f8e384ff9fd7', type: 'light', capabilities: COLOR_BULB },
  { label: 'Light 2', stId: 'd82bda78-4f9b-4069-982e-b8d8af4dccd0', type: 'light', capabilities: COLOR_BULB },
  { label: 'Light 3', stId: 'c17a9a75-5990-4638-bea8-64c9b96b2890', type: 'light', capabilities: COLOR_BULB },
  { label: 'Light 4', stId: 'fe2dc605-3fd0-49eb-879e-9e00f252f5d5', type: 'light', capabilities: COLOR_BULB },
  { label: 'Right Window Light', stId: 'e39a788e-d559-429b-a18c-298382429b2d', type: 'light', capabilities: SWITCH },
  { label: 'TV Lamp', stId: '9bd3918b-26ee-4fbb-82cc-99c6a61da528', type: 'light', capabilities: SWITCH },
  { label: 'Light 5', stId: '434402bd-cea2-463d-95e3-f9a1735e6ce8', type: 'light', capabilities: COLOR_BULB },
  { label: 'Aqara Roller Shade Controller of dining', stId: '09611dc5-d2d0-4d4b-a3a1-ce6bc9ab1c4d', type: 'blinds', capabilities: SHADE },
  { label: 'side lamp', stId: 'facda6c1-5784-4819-bd73-02dc7f6925ea', type: 'light', capabilities: SWITCH },
];

/** Argument ranges the real devices accept (SmartThings refuses values outside them). */
export const RANGES = {
  level: [1, 100] as const,          // switchLevel.setLevel
  kelvin: [2200, 6500] as const,     // colorTemperature.setColorTemperature
  shade: [0, 100] as const,          // windowShadeLevel.setShadeLevel
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export const zoneDeviceByLabel = (label: string) => ZONE_DEVICES.find(z => norm(z.label) === norm(label)) ?? null;
