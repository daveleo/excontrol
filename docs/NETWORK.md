# Network & security

For IT/AV teams who need to know exactly what eXcontrol opens and talks to before it goes
on a venue network. See also the [network model note in the README](../README.md#network--security-model)
for the reasoning behind the "trusted LAN, no TLS" design, and
[`SECURITY.md`](SECURITY.md) for the broader security posture and how it compares to other
AV control software.

## Inbound

| Port | Protocol | Purpose |
|---|---|---|
| **8080** (configurable) | HTTP (plain, no TLS) | The control panel itself — the web UI, the REST API, and the live `/ws` WebSocket feed. Every phone/tablet/PC that operates the room connects here. |

- The port is set in **Devices → App settings** and takes effect immediately (every open
  browser follows automatically); it is **not** fixed at 8080.
- The Windows installer adds one inbound firewall rule scoped to the `eXcontrol.exe`
  program (all profiles) — not just this one port — so the app can be reached from the LAN.
  Uninstalling removes it.
- `bind` in the config (default `0.0.0.0`) controls which network interfaces the server
  listens on; set it to a specific LAN IP to keep it off other interfaces (e.g. a
  Tailscale/VPN adapter on the same machine).
- If an **access password** is set (recommended — see the README), every route above except
  `/health` and the login endpoints itself requires it. Without one, anyone who can reach
  the port has full control — treat the port like a physical door key.
- No other inbound port is ever opened by eXcontrol itself.

## Outbound

eXcontrol only talks to what's configured, plus one optional update check. Nothing is sent
anywhere else — no analytics, no telemetry, no third-party trackers.

| Destination | Protocol / port | When | Purpose |
|---|---|---|---|
| Each configured **NovaStar H-series** controller | HTTP, TCP (device's configured port, default **8000**) | Continuously while running (poll interval, default 5s) + on every control action | OpenAPI calls: read status/screens, set brightness/preset/blackout. |
| Each configured **NovaStar COEX** (MX40 Pro, etc.) | HTTP, TCP (default **8001**) | Same as above | Same, COEX's own API. |
| Each configured **Expromo EPS** | Plain TCP (default **5000**) | Same as above | `POWER_STATUS`/`POWER_ON`/`POWER_OFF`/`OUTx_ON`/`OUTx_OFF` — polling status and issuing power/relay commands. |
| Each configured **OBS Studio** instance | WebSocket, TCP (default **4455**) | Continuously (persistent connection) + on every scene/action | obs-websocket protocol: scene list, current scene, recall a scene. |
| `api.github.com`, `github.com`, `objects.githubusercontent.com` | HTTPS (443) | On launch (a few seconds after boot) and when the operator clicks "Check for updates" | electron-updater checking/downloading eXcontrol releases from the public [`daveleo/excontrol`](https://github.com/daveleo/excontrol) GitHub repo. No account, no token, no data about the install is sent — it's an anonymous "is there a newer tagged release" HTTPS GET. Nothing downloads without the operator clicking **Install now**. |

- All four device connections are configured per-install in the setup wizard — an install
  with only an EPS talks to nothing but that EPS (plus the optional update check).
- None of this traffic leaves the LAN except the GitHub update check. If an install must
  never reach the internet, that's fine too: the update check fails silently (shows "no
  update info" in the UI) and everything else keeps working.
- All device protocols above are **plaintext** (no TLS) — this is inherent to how NovaStar,
  Expromo and obs-websocket work today, not something eXcontrol adds. Keep controllers on a
  dedicated AV VLAN/subnet, not a shared office network.

## Data at rest

- Device credentials (NovaStar OpenAPI secret key, OBS WebSocket password) are stored in
  plain text in the config file (`%ProgramData%\eXcontrol\excontrol.config.json`) — same
  trust model as the network above: anyone with filesystem access to the control PC has
  them. This file is never transmitted anywhere except via an explicit **Export config**
  (Devices → App settings → Backup), which the operator triggers and downloads themselves.
- The access password (if set) is stored as a salted scrypt hash, never in plaintext.
- Logs (`%ProgramData%\eXcontrol\logs\`) do not include device secrets or the access
  password.
