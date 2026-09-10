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

## License

MIT.
