# eXcontrol

A simple, free web control overlay for LED installations. One screen — phone, tablet, or
the control PC — for brightness, presets, blackout, power and OBS scenes, across as many
controllers as the install has.

Supports **NovaStar H-series** and **COEX** processors, **Expromo EPS** power units, and
**OBS Studio**. Every device is optional; you can have any number of each.

> **Status: pre-release (v0.1.0).** The generalised core, the Windows installer, the
> first-run setup wizard, and the update checker are all in place — see
> [`docs/ROADMAP.md`](docs/ROADMAP.md) for what's left. No published release yet, so for
> now build the installer yourself (`npm run desktop:dist`) or run from source (below). The
> production predecessor for the Expromo Aarhus showroom is
> [`showroom-control`](https://github.com/daveleo/showroom-control) (frozen at `v1.0`).
>
> The build is **unsigned** (no code-signing certificate yet) — Windows SmartScreen will
> show "Windows protected your PC" the first time someone runs the installer. Click
> **More info → Run anyway**. This is expected for every pre-release build; it'll go away
> once the project has a signing certificate.

## What it does

- **Per-screen control** — brightness, presets and blackout for each screen on each
  NovaStar controller, from a slider and a couple of taps.
- **Power** — on/off per EPS unit, with a plain-language status (ON / Starting up… /
  Powered down / not responding) and per-output warnings. Optionally, **independent output
  control** exposes up to 6 named relays per EPS as their own on/off switches with live
  state, alongside — not instead of — the whole-unit Power button.
- **Presets** — save a look (brightness + presets + blackout + OBS scene across devices)
  and recall it with one tap, or set it as the power-on default for a power unit.
- **Scheduler** — power on/off or apply a preset on a daily/weekly schedule, with a
  15-minute shutdown countdown and "extend by an hour".
- **Live** — every open screen shows the same state, updated in seconds, no refresh.
- **Dark / bright mode** — a switch top-right of the control panel; follows the OS theme
  until the operator picks one, then remembers it per-browser.
- **Access password (optional)** — lock the *entire* control panel behind a shared
  password from the Devices screen: viewing state, brightness, blackout, power, presets,
  the schedule, settings, all of it. Nobody without the password sees anything but a login
  screen.
- **Integrates with Bitfocus Companion today** via its Generic HTTP module — see
  [`docs/COMPANION.md`](docs/COMPANION.md).
- **Updates itself** — checks public GitHub Releases on launch and on demand (tray →
  Check for updates); *Install now / Skip this version / Remind me later*, never a silent
  auto-install. Every open browser sees a small banner when one's waiting, even though
  only the control PC can run the installer.
- **Backup & diagnostics** (Devices → App settings → Backup) — export the whole config
  (including device credentials, to pre-stage a new PC) or import one back; download a
  redacted diagnostics zip (config + live state + recent logs) to send to support.

## Run from source

```bash
npm install
npm run build --workspace shared     # once
npm run dev:backend                   # :8080
npm run dev:frontend                  # :5173 (proxies to :8080)
```

Start with no config and add your devices in the browser — the setup wizard opens
automatically on first run (or via **Devices** in the top bar). It walks through the
H-series OpenAPI key, tests each connection, and writes the config for you. To pre-fill it
by hand instead, copy `config/excontrol.config.example.json` to
`config/excontrol.config.json`. In production the config lives at
`%ProgramData%\eXcontrol\excontrol.config.json` (`EXCONTROL_DATA_DIR`).

## Config

```jsonc
{
  "app": { "name": "eXcontrol", "httpPort": 8080, "bind": "0.0.0.0" },
  "devices": [
    { "id": "h-main", "type": "novastar-h", "label": "Main Wall", "enabled": true,
      "host": "10.0.0.10", "port": 8000,
      "pId": "...", "secretKey": "...", "encrypted": false,
      "poweredBy": "eps-1",
      "zones": [ { "id": "z1", "label": "Main", "screenId": 0 } ] },
    { "id": "eps-1", "type": "expromo-eps", "label": "Power", "enabled": true,
      "host": "10.0.0.20", "port": 5000 }
  ],
  "presets": [ /* saved via the UI */ ],
  "schedule": { "entries": [ /* saved via the UI */ ] }
}
```

- `zones` empty → the driver discovers the controller's screens on start.
- `poweredBy` → which EPS powers this device; `null` = always on.
- An EPS can set `"independentOutputs": true` and an `outputs` array
  (`{ "id": "o1", "label": "House lights", "index": 1 }`, `index` 1-6, matching the unit's
  physical relay) to expose named relays as separately switchable zones — set up from
  **Devices**, not by hand-editing this file, but the shape is the same either way. The
  whole-unit Power on/off button works the same whether this is set or not.
- A device with `enabled: false` doesn't just show as offline — it's left out of the
  dashboard entirely.
- The whole file (including presets and schedule, which the UI edits) is one JSON document
  and is **not** committed — it holds device credentials.

## Network & security model

eXcontrol assumes a **dedicated, trusted LAN** (a venue's AV network, not a shared office
Wi-Fi) — it runs on plain HTTP, no TLS. On a private network the usual reasons for HTTPS
(eavesdropping, tampering in transit) don't really apply, and a self-signed cert would just
mean every phone has to click through a browser warning once. If an install ever needs to
be reachable from outside that trusted network, put it behind a VPN/Tailscale rather than
exposing it directly.

What *is* worth locking down on a shared LAN: who gets to touch the room at all. Setting
an **access password** (Devices → App settings → Access password) gates the whole
control panel — the REST API and the live WebSocket feed both require it, so an
unauthenticated browser gets a login screen and nothing else, not even read-only state.
It's one shared password, not per-user accounts; a login is a bearer token good for 30
days, and a per-IP rate limit (5 failures/60s → 30s lockout) caps how fast anyone can
guess it. The password itself is stored as a salted hash in the config file, never in
plaintext. **If it's forgotten**, stop the app and delete the `settingsPasswordHash` /
`settingsPasswordSalt` keys from `excontrol.config.json` — that removes the lock, same as
any other local device's "physical access resets it" recovery.

The control panel's **port** is configurable from the same App settings section; changing
it reconnects every open browser to the new port automatically.

See [`docs/NETWORK.md`](docs/NETWORK.md) for the full inbound-port + outbound-traffic
breakdown IT/AV teams typically ask for before deployment.

## License

MIT.
