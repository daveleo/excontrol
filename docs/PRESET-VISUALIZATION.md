# Preset visualization and the customer view

**Goal:** an even simpler overlay for the end customer. There are no settings: only **On / Off**,
the **schedule**, and every preset shown **as a picture of what it puts on the screen**. We
already read the preset list from the controllers; the NovaStar H-series API also says where
every layer sits, and that is enough to draw each preset.

Built and verified 2026-09-29 on branch `pi-kiosk`, against the real H9 in the Aarhus showroom
(screens `LED_All` and `HDMI_Out`), shown on the Raspberry Pi kiosk.

---

## 1. What the H9 Open API gives us (found by probing, read-only)

All calls use the driver's existing signed envelope (`POST /open/api<address>`,
`{body, sign, pId, timeStamp}`, see `backend/src/drivers/novastar-h.ts`).

| Address | Body | Useful response fields |
|---|---|---|
| `/screen/readList` | `{deviceId}` | `screens[] {screenId, name}` |
| `/screen/readDetail` | `{deviceId, screenId}` | `brightness`, `Ftb.enable`, and **`outputMode.screenInterfaces[] {x, y, width, height, outputId, isCardOnline}`**, the screen's physical output cells, plus `outputMode.mosaic {row, column}` and `outputMode.offset {x, y}` |
| `/preset/readList` | `{deviceId, screenId}` | `presets[] {presetId, name}` |
| **`/preset/readDetail`** | `{deviceId, screenId, presetId}` | **`layers[]`**: `window {x, y, width, height}`, `general {zorder, name, layerId, isBackground, isFreeze}`, `source {name, inputId, interfaceType, slotId}` |
| `/input/readList` | `{deviceId}` | `inputs[] {inputId, name, resolution {width, height, refresh}, isUsed, online}`: **`resolution.width > 0` = signal present** |

Probed and **not** available on this firmware (HTTP 200 with `status 500 Server_Err`, or
`status 1 Params_Error`): `/preset/readLayers`, `/preset/readLayerList`, `/preset/read`,
`/layer/readList`, `/layer/readDetail`, `/screen/readLayers`. As a result, **there is no call
that says which preset is currently live, or what the live layers are.**

### Coordinate system

Layer windows and output cells share **one absolute coordinate space, offset at (1000, 1000)**
(`outputMode.offset`). The canvas is the **bounding box of the output cells**:

| Screen | Output cells | Canvas |
|---|---|---|
| `LED_All` (s0) | 2×2 × 3840×2160 | 7680×4320 at (1000, 1000) |
| `HDMI_Out` (s1) | 2×2 × 1920×1080 | 3840×2160 at (1000, 1000) |

Example: HDMI_Out preset *Test1* has input 2-2 at `window {x:1000, y:1000, w:960, h:540}`,
the top-left quarter of the first FHD cell, which matches the controller UI's `X 0 Y 0 W 960 H 540`.
Layer order comes from `zorder` (higher = on top); the layers array is returned top-first.

---

## 2. Data model (`shared/src/index.ts`)

Everything is normalised to **fractions (0..1) of the canvas**, so the UI never needs controller
coordinates:

```ts
interface Preset { id; name; hasSignal?; layers?: PresetLayer[] }   // layers bottom → top
interface PresetLayer { x; y; w; h; z; source: string; signal?: boolean }
interface ZoneCanvas { width; height; cells: {x; y; w; h}[] }        // pixel size for the aspect ratio
interface ZoneState { …; canvas?: ZoneCanvas }
```

`signal` is absent when unknown. The H driver also keeps `x0/y0` (the absolute origin) on the
canvas it stores. That is harmless to the UI, and it lets a later poll normalise layers against a
canvas taken from the zone state.

---

## 3. Backend (`backend/src/drivers/novastar-h.ts`)

- `toCanvas(screenInterfaces)`: bounding box → `{x0, y0, width, height, cells[]}` with
  normalised cells. Computed from the `readDetail` call **the driver already made every poll**,
  so the canvas costs no extra request.
- `attachLayouts(screenId, deviceId, presets, canvas)`, run on every poll per zone:
  - **Preset details are cached per `device:screen:preset` and re-read after 60 s.** Layouts
    change only when someone edits a preset, so the 5 s poll does not multiply by the preset
    count; the cost is one `/preset/readDetail` per preset per minute.
  - **Input signal** (`/input/readList`) is refreshed at most every 10 s.
  - Layers with a zero-size window are dropped; the rest are normalised
    (`(window.x − x0) / width`, …), tagged with `signal` from the input map, and sorted by `z`.
  - Failures are logged at debug level and never fail the poll: thumbnails are best-effort,
    control is not.
- The result is patched into the zone (`presets` with `layers`, plus `canvas`), so it flows to
  every browser through the existing state/WebSocket path and lands in the **device cache** too.
  That cache is what gives simulated devices real drawings (see
  [`SIMULATED-DEVICES.md`](SIMULATED-DEVICES.md)).

Only H-series produces layouts today. COEX (MX40), eXview and OBS presets have no geometry in
their APIs as used by eXcontrol, and render as name tiles.

---

## 4. Frontend

### `components/PresetThumb.tsx`: the drawing

An SVG with `viewBox = 0 0 (aspect·100) 100`, so it scales crisply at any size:

- A dark rounded canvas (**always dark, in both themes**: it depicts a screen) with the output
  cells as a faint grid.
- Each layer as a rounded window in its input's colour (82 % opacity so overlaps read), drawn
  bottom to top, labelled **top-left** with the short input name (`"input 4-1"` → `4-1`), as
  the controller's own UI does. Centred labels collided when layers overlapped.
- **No signal:** a diagonal hatch pattern plus a "no signal" sub-label.
- **Colours:** `sourceColors()` assigns an 8-hue palette **in sorted input order across every
  screen on the page**. Every input gets a distinct colour (up to 8 inputs) and keeps it on every
  thumbnail and every screen, so a customer can follow "the laptop" from layout to layout.
  (A name hash was tried first; it made 2-2 and 4-2 near-identical oranges.)
- Label size scales with the layer (clamped); tiny layers get no label.

### `components/SimpleView.tsx`: the customer view (`?view=simple`)

- Header: room name, **Schedule** (with a count badge), and theme. **No Setup.**
- The existing **PowerBar** (On / Standby / Off, next scheduled change, +1 hour) and the
  **ShutdownModal** countdown, **SchedulerPanel** and **AlertPopup**, all reused unchanged.
- One section per zone that has presets. Zones with a canvas come first and show drawn tiles; the
  others (COEX, OBS scenes, eXview inputs) show plain name tiles.
- Section title: the device label, or the *zone* label with the device as a subtitle when the
  device has several preset zones. An *off* / *unavailable* tag appears when the device isn't
  online, and its tiles are disabled.
- **Tap a tile to recall the preset** (`recallPreset(device, zone, presetId)`: the same API
  the full dashboard uses). The tile pulses while pending. The active preset gets an accent ring
  and a **Live** chip.
- Selected in `App.tsx` by `?view=simple` (after the access gate, which still applies). The
  full dashboard is untouched.
- On the Pi kiosk it is the default (`pi/kiosk.sh`: `EXCONTROL_KIOSK_VIEW` defaults to
  `simple`; `full` shows the installer dashboard). With `.kiosk`, tiles get a wider minimum size.

---

## 5. How it was tested

1. The test Pi reaches the real H9 through a Tailscale `/32` route
   ([`PI-KIOSK.md`](PI-KIOSK.md) §5).
2. A standalone read-only probe (signed Open API calls from Node) mapped the endpoints above.
3. On the Pi, a **real** device `h-hdmi` (H9, zone `s1` = HDMI_Out only, credentials only in
   the Pi's own config) is controlled live. LED_All stays **simulated**, and its layouts were
   read once (read-only) into the sim's device cache, so the main wall can't be commanded from
   the Pi.
4. Results on the kiosk:
   - HDMI_Out *Test1* / *Test2* drawn from the live H9, matching the NovaStar UI screenshots.
   - LED_All's three presets (3–4 layers each; one uses input 3-2, correctly hatched as
     no signal).
   - Tapping *Test2* recalled it on the real HDMI_Out, and it was marked Live.
   - **Live refresh confirmed:** renaming input 4-1 to *CSE1* on the H9, and moving a layer
     in *Test2*, showed up on the kiosk within a minute.

---

## 6. Added after the UX review (2026-09-30)

- **"Live" means live.** Only OBS and eXview *report* their current scene/input; for them the tile
  says **Live**. H-series and COEX only remember what eXcontrol last recalled, so their tile says
  **Last chosen** (and the standard dashboard notes "highlighted = last chosen"). Nothing is live
  on a screen without power. (`reportsActivePreset()` in `shared`.)
- **Service presets hidden:** Setup › device › *On the dashboard* has a checkbox per
  preset/scene/input. Unticked ones (test patterns, mapping scenes) disappear from both dashboards
  but stay usable in scenes. Stored as `hiddenPresets: ["zoneId:presetId"]` on the device.
- **Customer input names:** Setup › device › *Input names* ("CSE1" → "Laptop"), used in the
  pictures. Stored as `inputNames` on the device. Inputs can also be renamed on the H9 itself; the
  driver picks that up within a minute.
- **Pictures in the standard dashboard** too, inside the H-series card.
- **Last-known pictures:** layouts are cached like the rest of a device's state, so the pictures
  stay visible while a screen is powered off.

## 7. Limits and next steps

- **No "which preset is live" from the H9.** The Live chip marks presets recalled *through
  eXcontrol*; a preset recalled on the controller itself is not reflected. (Worth asking NovaStar,
  or finding a current-layers read on newer firmware.)
- Colours repeat beyond 8 distinct inputs.
- The view is chosen by URL. Next: a setting (per installation, or per browser/kiosk), and a
  customer "names" layer ("Laptop" instead of `4-2`, per input).
- Ideas: live input snapshots inside the layer windows (if the H9 exposes preview images), app
  scenes (★) as picture tiles composed from their per-zone presets, and thumbnails in the full
  dashboard's device cards.
- Tests: add unit tests for `toCanvas` and the layout normalisation (pure functions over the
  sample responses in §1).
