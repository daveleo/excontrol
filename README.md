# eXcontrol

**[daveleo.github.io/excontrol](https://daveleo.github.io/excontrol/)** — product page + download link.

A simple, free web control overlay for LED installations. One screen — phone, tablet, or
the control PC — for brightness, presets, blackout, power and OBS scenes, across as many
controllers as the install has.

Supports **NovaStar H-series** and **COEX** processors, **Expromo EPS** power units,
**Expromo eXview Edge/AIO** displays, and **OBS Studio**. Every device is optional; you can
have any number of each.

> **Status: early access.** Download the Windows installer from the
> [latest release](https://github.com/daveleo/excontrol/releases/latest), or build it
> yourself (`npm run desktop:dist`) / run from source (below). See
> [`docs/ROADMAP.md`](docs/ROADMAP.md) for what's still ahead.
>
> The build is **unsigned** (no code-signing certificate yet) — Windows SmartScreen will
> show "Windows protected your PC" the first time someone runs the installer. Click
> **More info → Run anyway**. This is expected for every pre-release build; it'll go away
> once the project has a signing certificate.

## What it does

- **One power bar for the room** — the room's state in one word (On / Standby / Off /
  Starting…), one button that says what it will do (*Turn on* / *Turn off*), Standby, and
  the next scheduled change with *+1 hour*. Powering up runs EPS units one after another
  (one inrush at a time); powering down puts screens to standby first. See
  [`docs/POWER.md`](docs/POWER.md).
- **Power groups** — name sets of screens ("LED wall", "Lobby") and switch each On / Standby
  / Off. A screen can be in several groups; it follows the highest of them, so switching one
  group off never cuts something another group still wants on.
- **Per-screen control** — the same card for every display: status, picture (On · Black,
  plus Standby on eXview), brightness/volume, and presets or inputs.
- **Power units** — Expromo EPS with live output state; a device can sit on one output or
  the whole unit; outputs can be *protected* (never switched off by the app). Commands are
  verified and retried, and a partly-on unit is never power-cycled to switch it on.
- **Scenes** — save a look (brightness + presets + black + input + OBS scene across
  devices), tap it from the dashboard, or star one to apply automatically at power-on.
- **Schedule** — turn the room, a group or a power unit on / standby / off, or apply a
  scene, on a daily/weekly schedule. Entries read as sentences and save themselves; a
  15-minute warning and "+1 hour" apply to that one entry. If a screen is switched back on
  after its scheduled off, a pop-up says so.
- **Live** — every open screen shows the same state, updated in seconds, no refresh.
- **Dark / bright mode** — a switch top-right of the control panel; follows the OS theme
  until the operator picks one, then remembers it per-browser.
- **Access password (optional)** — lock the *entire* control panel behind a shared
  password (Setup › Access): viewing state, brightness, blackout, power, scenes, the
  schedule, everything. Nobody without the password sees anything but a login screen.
- **Setup** (gear, top bar) — everything that's configuration, in one place: Devices,
  Groups, Scenes, System (room name, port, autostart, updates), Access, Backup. The
  dashboard itself stays for operating the room.
- **Starts with Windows (optional)** — toggle "Start when Windows starts" in Setup › System;
  on by default, applies immediately without restarting the app.
- **Integrates with Bitfocus Companion today** via its Generic HTTP module — see
  [`docs/COMPANION.md`](docs/COMPANION.md).
- **Updates itself** — checks public GitHub Releases on launch, on demand from **Setup › System**,
  or from the tray; *Install now / Skip this version / Remind me later*, never a silent
  auto-install. Every open browser sees a small banner when one's waiting, even though
  only the control PC can run the installer.
- **Backup & diagnostics** (Setup › Backup) — export the whole config (including device
  credentials, to pre-stage a new PC) or import one back; download a redacted diagnostics
  zip (config + live state + recent logs) to send to support.

## Run from source

```bash
npm install
npm run build --workspace shared     # once
npm run dev:backend                   # :8080
npm run dev:frontend                  # :5173 (proxies to :8080)
```

Start with no config and add your devices in the browser — the setup wizard opens
automatically on first run (or via **Setup › Devices**). It walks through the
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
  "presets": [ /* "Scenes" in the UI */ ],
  "schedule": { "entries": [ /* saved via the UI */ ] },
  "groups": [ { "id": "wall", "label": "LED wall", "members": ["h-main"] } ]
}
```

- `zones` empty → the driver discovers the controller's screens on start.
- `poweredBy` → which EPS powers this device; `null` = its own socket. Add
  `poweredByOutput` (1-6) when it hangs off one output; without it the device shares every
  output no other device claims ("whole unit").
- An EPS output can be `"protected": true` (never switched off by power-off, groups or
  schedules — a network switch, the control PC); `minOffSeconds` (default 30) is how long an
  output stays off before the app switches it back on.
- `groups` → power groups (Setup › Groups). The room-wide group is built in and takes the
  display name (`app.name`), "Everything" while that is still the default.
- An EPS can set `"independentOutputs": true` and an `outputs` array
  (`{ "id": "o1", "label": "House lights", "index": 1 }`, `index` 1-6, matching the unit's
  physical relay) to expose named relays as separately switchable zones — set up from
  **Setup › Devices**, not by hand-editing this file, but the shape is the same either way. The
  whole-unit Power on/off button works the same whether this is set or not.
- A device with `enabled: false` doesn't just show as offline — it's left out of the
  dashboard entirely.
- The whole file (including scenes, schedule and groups, which the UI edits) is one JSON document
  and is **not** committed — it holds device credentials.

## Network & security model

eXcontrol assumes a **dedicated, trusted LAN** (a venue's AV network, not a shared office
Wi-Fi) — it runs on plain HTTP, no TLS. On a private network the usual reasons for HTTPS
(eavesdropping, tampering in transit) don't really apply, and a self-signed cert would just
mean every phone has to click through a browser warning once. If an install ever needs to
be reachable from outside that trusted network, put it behind a VPN/Tailscale rather than
exposing it directly.

What *is* worth locking down on a shared LAN: who gets to touch the room at all. Setting
an **access password** (Setup › Access) gates the whole
control panel — the REST API and the live WebSocket feed both require it, so an
unauthenticated browser gets a login screen and nothing else, not even read-only state.
It's one shared password, not per-user accounts; a login is a bearer token good for 30
days, and a per-IP rate limit (5 failures/60s → 30s lockout) caps how fast anyone can
guess it. The password itself is stored as a salted hash in the config file, never in
plaintext. **If it's forgotten**, stop the app and delete the `settingsPasswordHash` /
`settingsPasswordSalt` keys from `excontrol.config.json` — that removes the lock, same as
any other local device's "physical access resets it" recovery.

The control panel's **port** is configurable from Setup › System; changing
it reconnects every open browser to the new port automatically.

See [`docs/NETWORK.md`](docs/NETWORK.md) for the full inbound-port + outbound-traffic
breakdown IT/AV teams typically ask for before deployment, and
[`docs/SECURITY.md`](docs/SECURITY.md) for the honest security posture — what's protected,
what isn't, and how that compares to other AV control software.

## License

MIT.
