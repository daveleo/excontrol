# Security posture

For IT/security teams evaluating eXcontrol before it goes on a venue network. This is the
honest version — what's actually protected, what isn't, and why, so you can make an
informed call rather than take a vendor's word for it. See
[`NETWORK.md`](NETWORK.md) for the port-by-port inbound/outbound breakdown this document
assumes.

## The one-line summary

eXcontrol is built for a **trusted, isolated AV control network** — the same assumption
almost every product in this category makes (see [Comparison](#how-this-compares) below).
It is not designed to survive a hostile or shared network, and doesn't pretend to. Within
that trust boundary, it's deliberately hardened against the failure modes that are cheap to
fix and actually matter (brute-forcing the one shared password, silently leaking it in
logs); it does not attempt enterprise features (per-user accounts, TLS, audit trails) that
would add real complexity most single-room installs don't need.

## Authentication

- **One shared "access password"**, optional, set from Devices → App settings. Once set, it
  gates the *entire* control surface — every REST route and the live `/ws` feed — not just
  device configuration. Nobody without the password sees anything but a login prompt, not
  even read-only status.
- Stored as a **salted scrypt hash** (32-byte derived key, 16-byte random salt), compared
  with a timing-safe equality check. The plaintext password is never persisted and never
  logged.
- A successful login issues a **bearer token**, valid **30 days**, held in memory only (a
  restart invalidates every outstanding token). There is no per-token revocation — the only
  way to invalidate tokens early is changing the password, which clears all of them at once.
- **Rate-limited per source IP**: 5 failed attempts in 60 seconds locks that IP out for 30
  seconds. This exists to cap how much CPU a scripted guessing loop can force the server to
  spend on password hashing, not to withstand a determined, patient attacker — the code's
  own comment is blunt about this: *"the password is a shared LAN convenience lock, not a
  security boundary."*
- **No per-user identity.** It's one password for everyone who needs to operate the room.
  There's no way to tell which staff member did what, and no way to revoke one person's
  access without changing it for everyone.
- **No roles.** Anyone who authenticates can do anything — power the room off, delete
  presets, reconfigure devices. There's no read-only or operator-only tier.

## Transport

- **Plain HTTP, no TLS**, for the control panel itself and for every device protocol it
  speaks (NovaStar OpenAPI, Expromo EPS's TCP protocol, obs-websocket). This means the
  password (at login) and the bearer token (on every subsequent request) are sent
  unencrypted, and are readable by anything else with access to that network segment.
- This is a deliberate, stated trade-off, not an oversight: on a genuinely isolated AV VLAN,
  the usual reasons for TLS (an eavesdropper on the wire, a man-in-the-middle) require an
  attacker who already has a foothold on that segment — at which point they can likely
  reach the LED processors and EPS units directly anyway, since **those speak the same
  unencrypted protocols natively, with or without eXcontrol in the picture.**
- The mitigation is architectural, not cryptographic: **keep this network segment isolated**
  from guest Wi-Fi, corporate IT, and anything else untrusted. If the control panel ever
  needs to be reached from outside that segment, put it behind a VPN (we use Tailscale for
  our own remote support access) rather than exposing the port directly or forwarding it
  through a firewall.

## Data at rest

- Device credentials (NovaStar OpenAPI secret key, OBS WebSocket password) are stored in
  **plain text** in `%ProgramData%\eXcontrol\excontrol.config.json`. The installer does not
  apply any additional ACL to that folder — its permissions are whatever the OS default is
  for `%ProgramData%`, so in practice: anyone who can already log into that PC can read
  them, admin or not.
- The access password is the exception: it's a salted hash, never plaintext, in the same
  file.
- The config (with credentials) only ever leaves the machine via an explicit **Export
  config** (Devices → App settings → Backup) that the operator triggers and downloads
  themselves — nothing pushes it anywhere automatically.
- Logs (`%ProgramData%\eXcontrol\logs\`) are checked to exclude both the access password and
  device secrets.

## Network exposure

- The control panel **binds to `0.0.0.0` by default** — every network interface on that
  machine, not just the AV VLAN's. If the control PC has a second NIC on a different
  network (a guest Wi-Fi dongle, a corporate LAN port), the panel is reachable there too
  unless `bind` is deliberately set to the AV VLAN's own address in App settings.
- The Windows installer opens one inbound firewall rule scoped to the `eXcontrol.exe`
  program (not a specific port) so the app is reachable from the LAN; uninstalling removes
  it.

## Supply chain

- **Open source, MIT-licensed**, public repository — every line is auditable by your own
  security team rather than taken on trust. This cuts both ways honestly: it also means
  anyone else can read it, including whoever might be probing for a way in, but "security
  through visibility" is a defensible trade for a tool this size.
- The Windows installer is currently **unsigned** (no code-signing certificate yet), so
  Windows SmartScreen warns on first run. Beyond GitHub's own HTTPS delivery and the
  repository's commit history, there is no independent cryptographic assurance that a given
  build wasn't tampered with in transit.
- **Auto-update** checks the public GitHub Releases feed for the `daveleo/excontrol` repo —
  anonymous, no account or token, nothing about the install is reported. It never
  auto-downloads or auto-installs; every update requires the operator to click **Install
  now** on an explicit prompt.

## How this compares

The honest context: this is roughly where most AV control software sits, and in a couple of
respects eXcontrol does better than tools it's often deployed alongside.

| | eXcontrol | Bitfocus Companion | Typical Crestron/Extron install | Enterprise tier (Q-SYS, Crestron XiO) |
|---|---|---|---|---|
| Transport | Plain HTTP | Plain HTTP | Often plain HTTP/Telnet | HTTPS available |
| Auth on control actions | Optional shared password, gates everything | **None by default** | Frequently none, or a static PIN | Username/password, sometimes AD/SSO |
| Brute-force protection | Yes | No | Rarely | Usually yes |
| Per-user identity / audit trail | No | No | No | Yes |
| Source auditable | Yes | Yes | No (closed) | No (closed) |

Worth noting explicitly: **Bitfocus Companion — which typically sits right next to
eXcontrol driving the same Stream Deck — has no password option at all on the API it uses
to talk to eXcontrol or anything else.** The NovaStar and Expromo EPS protocols eXcontrol
itself talks to are also unauthenticated (NovaStar's OpenAPI key is a static shared secret,
not unlike eXcontrol's own password). None of this is an excuse — it's the actual baseline
this category of tool operates at, and useful context for judging where eXcontrol lands.

## Recommendations for deployment

1. **Keep the control network isolated** — a dedicated AV/control VLAN, not shared with
   guest Wi-Fi or general corporate traffic. This one step resolves nearly everything above.
2. **Set an access password.** It's optional, but there's no reason to leave it off once
   there's more than one person with LAN access.
3. **Set `bind` to the AV VLAN's specific IP** rather than leaving it at `0.0.0.0`, if the
   control PC has any other network interface.
4. **Remote access goes through a VPN**, never a direct port-forward or firewall exception
   to the public internet.
5. If the venue needs **individually-attributable access for many different staff or
   contractors**, that's a genuinely different requirement — this is the point to reach for
   an enterprise-tier platform with AD/SSO integration instead of asking eXcontrol to
   become something it isn't.

## What we'd add if requirements grow

Not planned unless a real need shows up, but cheap enough to be worth naming rather than
pretending they're impossible:

- Encrypting device credentials at rest with Windows DPAPI — transparent to the operator,
  ties the config to that specific machine, no new UI.
- Making the setup wizard default `bind` to the detected LAN IP instead of `0.0.0.0` when
  one is known at setup time.
- Code signing, once there's a certificate — removes the SmartScreen warning and adds
  binary-tampering assurance.

None of these turn eXcontrol into a multi-user, audited, enterprise access-control system —
that's a different product, deliberately not this one.
