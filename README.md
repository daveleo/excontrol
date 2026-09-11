# eXcontrol

A simple, free web control overlay for LED installations. One screen — phone, tablet, or
the control PC — for brightness, presets, blackout, power and OBS scenes, across as many
controllers as the install has.

Supports **NovaStar H-series** and **COEX** processors, **Expromo EPS** power units, and
**OBS Studio**. Every device is optional; you can have any number of each.

> **Status: pre-release (v0.1.0).** The generalised core, the Windows installer and the
> first-run setup wizard are in place; the update checker and diagnostics export are still
> to come — see [`docs/ROADMAP.md`](docs/ROADMAP.md). No published release yet, so for now
> build the installer yourself (`npm run desktop:dist`) or run from source (below). The
> production predecessor for the Expromo Aarhus showroom is
> [`showroom-control`](https://github.com/daveleo/showroom-control) (frozen at `v1.0`).

## What it does

- **Per-screen control** — brightness, presets and blackout for each screen on each
  NovaStar controller, from a slider and a couple of taps.
- **Power** — on/off per EPS unit, with a plain-language status (ON / Starting up… /
  Powered down / not responding) and per-output warnings.
- **Presets** — save a look (brightness + presets + blackout + OBS scene across devices)
  and recall it with one tap, or set it as the power-on default for a power unit.
- **Scheduler** — power on/off or apply a preset on a daily/weekly schedule, with a
  15-minute shutdown countdown and "extend by an hour".
- **Live** — every open screen shows the same state, updated in seconds, no refresh.
- **Settings password (optional)** — lock device setup and preset/schedule editing behind
  a shared password from the Devices screen. Zone control, power and preset *apply* stay
  open to any phone on the network either way — it only protects reconfiguration.
- **Integrates with Bitfocus Companion today** via its Generic HTTP module — see
  [`docs/COMPANION.md`](docs/COMPANION.md).

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
- The whole file (including presets and schedule, which the UI edits) is one JSON document
  and is **not** committed — it holds device credentials.

## Network & security model

eXcontrol assumes a **dedicated, trusted LAN** (a venue's AV network, not a shared office
Wi-Fi) — it runs on plain HTTP, no TLS. On a private network the usual reasons for HTTPS
(eavesdropping, tampering in transit) don't really apply, and a self-signed cert would just
mean every phone has to click through a browser warning once. If an install ever needs to
be reachable from outside that trusted network, put it behind a VPN/Tailscale rather than
exposing it directly.

What *is* worth locking down on a shared LAN: reconfiguration. Setting a **settings
password** (Devices → App settings → Settings password) requires it for the Devices
screen and for editing presets/schedules; brightness, blackout, power and applying an
existing preset stay reachable from any phone with no password, by design. The password is
stored as a salted hash in the config file, never in plaintext. **If it's forgotten**, stop
the app and delete the `settingsPasswordHash` / `settingsPasswordSalt` keys from
`excontrol.config.json` — that removes the lock, same as any other local device's
"physical access resets it" recovery.

The control panel's **port** is configurable from the same App settings section; changing
it reconnects every open browser to the new port automatically.

## License

MIT.
