# 4th Floor · SmartThings Zone Devices

Real devices in the 4th floor SmartThings Experience Zone (room 401), with the commands each supports. Device IDs
are the SmartThings `deviceId` values used by the REST API. The same list is in code in
[`web/lib/integrations/zone-devices.ts`](../web/lib/integrations/zone-devices.ts): the zone's twin devices carry these
labels and are linked to these IDs as soon as a token is configured.

## Connecting

Put the SmartThings access token in `web/.env` (never in this folder, which is tracked by git):

```bash
SMARTTHINGS_TOKEN=<access token>
# optional: how often the devices' real status is read, in ms (default 2000)
SMARTTHINGS_POLL_MS=2000
```

Or paste it on `/integrations` (kept in memory only). The token needs the scopes `r:devices:*` and `x:devices:*`
(and `r:locations:*` for the account sync on `/integrations`).

## Controlling a device

```bash
curl -X POST 'https://api.smartthings.com/v1/devices/{deviceId}/commands' \
  -H 'Authorization: Bearer <access token>' \
  -H 'Content-Type: application/json' \
  -d '{"commands":[{"component":"main","capability":"switchLevel","command":"setLevel","arguments":[60]}]}'
```

## Checking the real devices

`tools/smartthings_zone_check.py` (Python standard library only) checks every device against the API: the deviceId
exists for the token, the label and capabilities are as above, health and status. With `--control` it runs every
command each device supports, waits until the device reports the change, then restores the device as it was (lights
and shades change for a few seconds each):

```bash
python3 tools/smartthings_zone_check.py              # read-only; token from SMARTTHINGS_TOKEN or web/.env
python3 tools/smartthings_zone_check.py --control    # full command test
python3 tools/smartthings_zone_check.py --control --only "Light 1"
```

## Live status

All the zone's devices are read in one request per round (every `SMARTTHINGS_POLL_MS`):

```bash
curl 'https://api.smartthings.com/devices?deviceId={id1}&deviceId={id2}&includeStatus=true&includeHealth=true' \
  -H 'Authorization: Bearer <access token>' \
  -H 'Accept: application/vnd.smartthings+json;v=20170916'
```

If the API answers that request without statuses, each device is read with `GET /v1/devices/{deviceId}/status`
(and `/health` every 30 s) instead, at most every 4 s. A `429` pauses polling for the time SmartThings asks.

## Devices (13)

| Device | Device ID | Twin type | Commands |
|---|---|---|---|
| Aqara Roller Shade Controller | `77233c09-6de7-4903-a137-ea7bf1d301ae` | blinds | `windowShade.open`, `windowShade.close`, `windowShadeLevel.setShadeLevel` (0–100) |
| Blinds Switch | `648ac2ca-a762-4fb1-91be-b8eba39b5c2c` | plug | `switch.on`, `switch.off` |
| Desk Lamp | `0f477ef7-8574-4be9-9bb3-f72ed5f719e6` | light (colour) | `switch.on/off`, `switchLevel.setLevel` (1–100), `colorTemperature.setColorTemperature` (2200–6500), `colorControl.setColor` (hue, saturation) |
| Left Window Light | `aaa3da5b-bbda-4b4e-90fc-ac11f0c6071c` | light (switch) | `switch.on`, `switch.off` |
| Light 1 | `ce885b72-4a0a-47c3-9549-f8e384ff9fd7` | light (colour) | as Desk Lamp |
| Light 2 | `d82bda78-4f9b-4069-982e-b8d8af4dccd0` | light (colour) | as Desk Lamp |
| Light 3 | `c17a9a75-5990-4638-bea8-64c9b96b2890` | light (colour) | as Desk Lamp |
| Light 4 | `fe2dc605-3fd0-49eb-879e-9e00f252f5d5` | light (colour) | as Desk Lamp |
| Right Window Light | `e39a788e-d559-429b-a18c-298382429b2d` | light (switch) | `switch.on`, `switch.off` |
| TV Lamp | `9bd3918b-26ee-4fbb-82cc-99c6a61da528` | light (switch) | `switch.on`, `switch.off` |
| Light 5 | `434402bd-cea2-463d-95e3-f9a1735e6ce8` | light (colour) | as Desk Lamp |
| Aqara Roller Shade Controller of dining | `09611dc5-d2d0-4d4b-a3a1-ce6bc9ab1c4d` | blinds | as Aqara Roller Shade Controller |
| side lamp | `facda6c1-5784-4819-bd73-02dc7f6925ea` | light (switch) | `switch.on`, `switch.off` |

All on the `main` component.

## How the twin follows them

- A command from the map, a guest, the assistant or a story goes to the real device; the twin shows the new value at
  once and keeps it until the device reports it (up to 8 s, 24 s for a shade), so it never flicks back.
- A change made anywhere else (the SmartThings app, a wall switch, an automation) shows on the 3D twin within one
  polling round plus the renderer's 1 s poll (about 2–3 s with the defaults).
- A colour bulb shows the colour or the white (colour temperature) it was set to last, from the attribute timestamps.
- A device that SmartThings reports offline is greyed out in the room and its light goes dark.
- Moving the Aqara Roller Shade Controller switches the Blinds Switch (its motor's power) on first.
- Commands a device does not have are refused (e.g. a colour for Left Window Light).
- Testing without an account: `python3 tools/smartthings_mock.py` serves these 13 devices under the same IDs
  (`POST /_set/{deviceId}` changes one as the app would); start the web app with
  `SMARTTHINGS_API=http://127.0.0.1:9010/v1 SMARTTHINGS_TOKEN=test-token`.
