# Driving eXcontrol from Bitfocus Companion

eXcontrol's HTTP API is already the uniform, debugged interface to your H-series / COEX /
EPS / OBS gear — Companion doesn't need a NovaStar or EPS module at all. Its built-in
**Generic HTTP Request** action can call eXcontrol directly, today, with no changes on
either side.

This covers *actions* (Stream Deck button → eXcontrol does something). Companion's generic
HTTP module has no live feedback, so button colours won't track state yet — that needs a
proper `@companion-module` package talking to eXcontrol's `/ws`, which is a separate,
larger piece of future work (see `ROADMAP.md`).

## Find your ids

`GET http://<control-pc>:8080/api/state` lists every configured device, its zones, and its
presets. The ids in that response (`h9`, `led`, `eps`, preset ids, …) are what go in the
URLs below. Example from a real config:

```json
{
  "id": "h9", "type": "novastar-h",
  "zones": [
    { "id": "led", "label": "LED_All", "presets": [{ "id": 0, "name": "MAIN_NIX_PILLE" }] },
    { "id": "hdmi", "label": "HDMI_Out" }
  ]
}
```

## Actions Companion can fire (Generic HTTP Request)

None of these need a password/token, even if you've set a settings password on the
Devices screen — that lock only protects *configuration* (device setup, preset editing,
schedule editing), never control.

| What | Method | URL | Body (JSON) |
|---|---|---|---|
| Set brightness | POST | `/api/devices/h9/zones/led/brightness` | `{"brightness": 60}` |
| Recall a controller preset | POST | `/api/devices/h9/zones/led/preset` | `{"presetId": 0}` |
| Blackout on/off | POST | `/api/devices/h9/zones/led/blackout` | `{"blackout": true}` |
| Power an EPS unit | POST | `/api/power/eps/on` (or `/off`, or target `all`) | — |
| Recall an OBS scene | POST | `/api/devices/obs/zones/scenes/preset` | `{"presetId": 1}` |
| Apply a saved eXcontrol preset (cross-device look) | POST | `/api/presets/<preset-id>/apply` | — |
| Raw EPS command | POST | `/api/devices/eps/action/power_on` (or `power_off`, `status`) | — |

Use `-` as the zone id (`/api/devices/h9/zones/-/brightness`) to hit a device's first/only
zone without knowing its id — handy for single-zone controllers.

## Setting it up in Companion

1. Add the **Generic HTTP** connection, target `http://<control-pc-ip>:8080`.
2. New button → **Add action** → *Generic HTTP → Request*.
3. Method `POST`, URL path from the table, `Content-Type: application/json`, body the JSON
   shown. For a GET-only feedback, `/api/state` returns the same JSON `GET /api/state`
   returns to the web UI, if you want to build a poller.
4. Test with a real Companion button before wiring the whole panel — a wrong zone/device id
   comes back as `{"error": "..."}` with an HTTP 4xx, visible in Companion's connection log.

## Why this beats wiring Companion to the hardware directly

The NovaStar / EPS quirks eXcontrol already solved — the H-series OpenAPI signing and its
inverted "Disable" toggle, the inverted FTB blackout flag, COEX's canvas-id requirement for
blackout, the EPS's raw `k=v;k=v` TCP protocol — would otherwise all have to be re-solved
inside a custom Companion module. Point Companion at eXcontrol instead and none of that
matters to Companion: it just calls a clean, uniform, already-verified endpoint.

## What's next (not built yet)

A real `@companion-module/base` package would add: native actions (dropdowns of your
*actual* configured zones/presets, not hand-typed ids), live feedback (button colour follows
`/ws` state — power on/off, active preset, blackout), and Companion variables (current
brightness, EPS status). Worth doing once there's a second site that wants tighter
Stream Deck integration than the table above gives.
