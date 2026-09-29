# Simulated devices

Any device in the config can be marked **`"simulated": true`**. It then runs **in memory**,
with no network traffic, but it goes through the same store, power engine, groups, scenes
(app presets) and schedule as a real driver. It exists for demos, the Pi kiosk
proof-of-concept, UI work without hardware, and trying a customer's layout before install.

Added on branch `pi-kiosk`. It is platform-neutral and merge-ready (see
[`ROADMAP.md`](ROADMAP.md) → *Phase 15*).

## Using it

- **Setup → Devices → (device) → "Simulated" switch**, next to *Enabled*. On shows "Simulated —
  demo device, no network"; off shows "Real device". In the collapsed device list, a
  simulated device shows `simulated` instead of `host:port`.
- **Test connection** on a simulated device returns ok ("Simulated device — nothing to connect
  to") without touching the network (`backend/src/setup/probe.ts`).
- The flag survives a wizard save (`toSetupDevice`/`fromSetupDevice` in `backend/src/config.ts`,
  `SetupDevice.simulated` in `shared/src/setup.ts`). Without that, a save would silently turn
  demo devices into real ones pointing at fake IPs.
- Switching a device back to real makes it connect to the host/port in its settings.

## How it works (`backend/src/drivers/sim.ts`)

`registry.build()` returns `new SimDriver(cfg)` when `cfg.simulated` is set, **before** the
per-type switch, so one class covers every device type:

| Type | Simulated behaviour |
|---|---|
| **EPS** | Six relay bits. `applyOutputs` / `action(power_on/off)` / `setOn(relay zone)`: switch-offs at once, switch-ons **one relay per second** with `STATE=SEQUENCING`. `extra` carries `system`, `state` (`FULLY_ON`/`PARTIAL`/`FULLY_OFF`/`SEQUENCING`), `outputs` — the same fields the power engine reads from a real unit. Protected outputs are never switched off except by the per-output button. Independent-output zones follow the bits. |
| **H-series / COEX** | Zones from the config (or a single "Screen 1"). Brightness, blackout and preset recall (4 generic presets) are held in memory. |
| **eXview** | One `screen` zone: brightness, volume, inputs (Android / HDMI 1 / HDMI 2), `setPowerState` on / blackout / standby. |
| **OBS** | A `scenes` zone with 4 scenes; `extra.programScene` follows the recall. App presets with `scene:` resolve by name (`core/presets.ts` gained a generic fallback, because the original path is `instanceof ObsDriver`). |

**Realism rules:**

- **Power-aware:** a non-EPS sim polls `store.powerOf(this.id)`. While its supply is off it
  fails its poll ("simulated: no power"), which the base driver maps to **powered-off**. When
  power returns it reports **initializing** for 6 s ("booting") before coming online, so the
  power engine's start-up sequencing and the dashboard behave as with real hardware.
- **Blackout is volatile:** on power loss a sim clears `blackout`, like a real controller,
  which comes back lit after a power cycle.
- **Starts from the device cache** when there is one (`getCachedZones(id)`). A cache copied
  from a real installation gives the real preset/scene names (and, for H-series, the preset
  layouts and canvas, see [`PRESET-VISUALIZATION.md`](PRESET-VISUALIZATION.md)). The sim's own
  patches keep the cache current, so its state survives restarts. EPS relay zones always come
  from the config.
- Polls every second (`pollMs` default 1000 on a *copy* of the config; the live config is
  never mutated).

## Demo configs

- **`pi/demo/excontrol.config.json`** (in the repo): generic and showroom-shaped. An EPS with
  six labelled relays (one protected), a two-screen "H9", an "H-2", an eXview, an MX40 and an
  OBS; groups *LED walls* / *Signage*; scenes *Showroom demo* (★ power-on default) and
  *Evening (dim)*; the showroom's schedule. All hosts are **documentation IPs (192.0.2.x)**, so
  even with the flag removed nothing real can be reached.
- **`pi/demo/apply.sh [dir]`** loads `dir/excontrol.config.json` (+ an optional
  `excontrol.device-cache.json`) into the unit's data dir. Devices, groups, presets and schedule
  are replaced; the `app` section (port, access password, name) is kept. Config and cache are
  backed up with a timestamp. Stop the service first when copying a cache, because a running
  backend flushes its own cache on stop.
- **A real installation as a demo:** export its structure with secrets stripped *on the source
  machine* (keys matching `secret|password|pId|Hash|Salt|token`), set `simulated: true` on every
  device, blank the credentials, and ship its device cache alongside. That is how the test Pi
  runs the Aarhus showroom. **Never commit such a copy** to this public repo: internal IPs,
  labels and customer-named presets stay on the unit (`~/showroom-demo/` on the Pi).

## Verified

- Locally and on the Pi: power on → EPS sequences all six outputs → controllers "boot" →
  the ★ scene applies itself (brightness / preset per zone, OBS scene) → groups report
  "N on"; power off → displays powered-off, the always-on OBS stays online.
- Backend test suite unchanged at 186 passing (no sim-specific tests yet: a follow-up).
