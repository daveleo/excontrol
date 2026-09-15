# Roadmap

## Phase 1 — generalised core  ✅ (v0.1.0)

- Config v2: any number of devices of any type, per-screen **zones**, `poweredBy` power
  domains, presets + schedule in the one config file.
- Per-zone drivers (H-series, COEX), per-EPS **power domains** with independent
  off → starting → on and power-on presets.
- **Presets** replace the fixed "startup defaults": named cross-device configurations,
  applied on demand or as a power-on default.
- Scheduler actions: `power_on` / `power_off` / `apply_preset`, per power unit or all.
- Front-end renders whatever is configured; light + dark themes.

## Phase 2 — Electron shell  ✅

- `desktop/` workspace; server runs in the Electron main process.
- Tray icon (Open control panel / Check for updates / Quit), normal resizable window,
  single-instance lock.
- `electron-builder` → NSIS installer (`eXcontrol-Setup-<version>.exe`), per-machine;
  `build/installer.nsh` writes `HKLM\…\Run\eXcontrol` (auto-launch at any user login)
  and an inbound Windows Firewall rule for the app — both removed on uninstall.
  Config in `%ProgramData%\eXcontrol\`. Replaces the pm2 / scheduled-task deployment.
- Validated on CBLATest (Win10 1607): silent `/S` install → Run key + firewall rule
  present, app serves all four showroom devices from `C:\Program Files\eXcontrol\`.
- Open: custom app icon (still the default Electron icon); unsigned → SmartScreen.

## Phase 3 — setup wizard  ✅

- First-run web wizard (full-screen when unconfigured, re-openable as the **Devices**
  toolbar button): add/remove devices and zones, per-device **Test** button with inline
  decoded results, "use detected zones", inline OpenAPI-key instructions.
- Each driver has a static `probe(cfg)` — one-shot, no polling — decoding real errors:
  H-series `15` (OpenAPI entry disabled) / `13` (project not set up) / `912` (booting) /
  `5xx` (secret or encryption mismatch); COEX `404` (not a COEX box); EPS TCP refused vs.
  no reply vs. non-EPS banner; OBS `4009`/`4008` auth vs. server-off.
- `GET /api/setup/state` (secrets redacted to a sentinel), `POST /api/setup/probe`,
  `GET /api/setup/scan` (TCP knock across this machine's /24 on 8000/8001/5000/4455),
  `POST /api/setup/save` (validates, merges kept secrets, persists, restarts drivers
  in-process — presets/schedule untouched).
- Validated on CBLATest against the showroom EPS + OBS (decoded ok/auth/unreachable);
  H/COEX success + status-code paths still to confirm against a powered-on room.
- Network discovery is a TCP port sweep, not NovaStar UDP broadcast (protocol unknown).

## Phase 4 — update checker  ✅

- `electron-updater` against public GitHub Releases (no token, `autoDownload: false`),
  wrapped in `desktop/src/updater.ts`. On launch (a few seconds after boot) and on tray →
  "Check for updates" → **Install now / Skip this version / Remind me later**; a skipped
  version is remembered in `update-prefs.json` next to `window.json` and not re-asked on
  automatic checks (a manual check always asks again). Never auto-downloads or
  auto-installs without that prompt.
- The backend has no idea what GitHub Releases are — main.ts posts what it learns to
  `POST /api/internal/update-status` (localhost-only), which lands in `AppState.updateInfo`
  and broadcasts over `/ws`, so **every open browser sees a small banner**, not just the
  control PC's own window (only it can run the installer, but anyone holding a phone
  should know one's waiting).
- Unsigned build → SmartScreen "More info → Run anyway" (now documented in the README).
- **CI + release workflow (`.github/workflows/ci.yml` / `release.yml`)**: every push/PR to
  `main` builds + typechecks + tests all four workspaces (`ubuntu-latest`); pushing a
  `vX.Y.Z` tag builds the Windows installer (`windows-latest`) and publishes it to that
  tag's GitHub Release via `electron-builder --publish always`, using the run's own
  `GITHUB_TOKEN` (`contents: write`) — no manual `GH_TOKEN` needed.
  - electron-builder's GitHub provider **defaults to creating a draft release**, which
    electron-updater's checker does not see — `v0.2.0`'s first release run produced exactly
    that (correct assets, wrong visibility) and had to be un-drafted by hand
    (`gh release edit v0.2.0 --draft=false`). Fixed for every release after it:
    `desktop/package.json`'s `build.publish` now sets `"releaseType": "release"`.
- **v0.2.0 — first real GitHub Release, published.**
  https://github.com/daveleo/excontrol/releases/tag/v0.2.0 — installer built + published by
  the release workflow above, end to end, no manual packaging step.

**Two real bugs found only by running the packaged app** (neither showed up in
typecheck/tests, both are now fixed):
- `import { autoUpdater } from "electron-updater"` type-checks fine but **throws at
  runtime** under Node's ESM loader ("Named export 'autoUpdater' not found") because
  electron-updater is CommonJS and esbuild leaves it un-bundled (external, so its own
  native/dynamic-require pieces stay real files rather than getting flattened). Fixed by
  importing the default and destructuring: `import pkg from "electron-updater"; const
  { autoUpdater } = pkg;`.
- A **non-`async` Fastify preHandler that returns nothing hangs the request forever** —
  it satisfies neither the callback-style nor the promise-style hook contract, so Fastify
  never learns the hook finished. `localhostOnly` (shared by `/api/internal/reload` and
  the new `/api/internal/update-status`) was written that way during this session's
  refactor and silently broke both endpoints; a real `curl` call hung for 120s before this
  was caught. Fixed by making it `async`; a regression test
  (`internal-routes.test.ts`) now asserts these routes actually resolve.
- Verified end-to-end against the real (release-less) `daveleo/excontrol` repo: packaged
  app boots, the scheduled check runs, `error: "No published versions on GitHub"` lands
  correctly in `/api/state`. This is strong evidence the whole pipeline works and will
  pick up a real release the moment one's tagged.

## Phase 5 — portability & support  ✅

- `GET /api/config/export` (full config incl. device credentials — the point is
  pre-staging a new PC; the settings-password hash/salt is stripped, it doesn't travel)
  and `POST /api/config/import` (validates, restarts drivers, keeps *this* machine's
  password no matter what the file carries). Both gated by the access password once
  one is set — same as everything else now (see Hardening below).
- `GET /api/diagnostics` — a zip (via `fflate`, pure JS, esbuild-bundled fine) with the
  redacted config, a live `/api/state` snapshot, `system.json` (OS/Node/eXcontrol
  versions, memory, uptime), and the last ~2000 log lines. Safe to hand to support.
- Devices → App settings → **Backup**: Export config / Import config file / Download
  diagnostics, each gated the same way as the rest of Devices.

## Hardening (ongoing, alongside the phases)

- **Test suite**: 2 → 95 tests — schedule math, config validation + secret redaction,
  the power-domain state machine (every branch) incl. multi-EPS, preset application, the
  settings-password/auth routes end-to-end incl. login rate limiting (Fastify
  `.inject()`), config export/import/diagnostics, the internal-routes hang regression,
  and every driver's `probe()` error decoding against fake servers. Test files are
  type-checked.
- **Fixed** (found by hardware + review): power domain now shows "starting up" (not a
  fault) when eXcontrol boots next to an already-on wall; `deletePreset` disables schedule
  entries that referenced it; wizard re-points `poweredBy` on an EPS rename; brightness
  slider debounces keyboard input.
- **Multi-device — validated on real hardware**: the showroom now runs **two H-series
  controllers** simultaneously (`h9` on the power domain, a second always-on `H-2`) plus
  MX40 and EPS, confirmed via CBLATest. Multi-EPS is still simulation-tested only.
- **Access password**: an optional shared password (Devices → App settings) that gates
  the **whole control panel** — every REST route and the `/ws` live feed both require it
  once set, so an unauthenticated visitor gets a login screen and nothing else, not even
  read-only state. (Originally scoped to settings-only; widened after real-world use —
  "lock unauthorized users from operating LED systems at all", not just from
  reconfiguring.) The one thing that stays reachable regardless: `/health` (ops liveness,
  no control) and the auth endpoints themselves. Browsers can't set a custom header on a
  WS handshake, so the token travels as `/ws?token=...` — `verifyClient` rejects the
  upgrade outright for a missing/bad token, checked before the socket ever opens. On the
  frontend, `App.tsx` checks `/api/auth/status` (always open) before rendering anything
  else — a locked, unauthenticated visitor sees only a full-page password prompt
  (`AccessGate`), never the dashboard shell. Salted **async** scrypt hash (moved off
  `scryptSync`, which blocked the whole event loop for ~35-40ms per attempt — measured,
  and a real DoS-by-login-spam risk before the fix) + bearer tokens (in-memory, 30-day
  TTL) + a per-IP rate limit (5 failures/60s → 30s lockout) on login and on
  set-password's current-password check. Forgotten password recovers by deleting the
  hash/salt from the config file.
- **Configurable port**: settable from the same App settings section; the backend rebinds
  its HTTP listener live (`registerHttpRestarter`/`restartHttpServer`) and the browser
  follows automatically. Devices don't restart for a pure port change.
- **Bitfocus Companion**: works today via its Generic HTTP module against eXcontrol's
  existing control endpoints — no eXcontrol changes needed. See
  [`COMPANION.md`](COMPANION.md). A native `@companion-module` package (dropdowns, live
  feedback) is future work, not started.
- **Dependency security**: `@fastify/static` bumped 8.3.0 → 10.1.3 (path-traversal /
  auth-bypass advisories on the 8.x line; verified normal serving + two traversal-style
  paths still only reach the SPA fallback). `electron-builder`'s own toolchain
  (`tar`/`cacache`/`node-gyp`/old `builder-util-runtime`) carries several build-time-only
  advisories — not shipped in the product, fixing them needs an electron-builder major
  bump not attempted this session.

## Phase 6 — EPS independent output control, theming, dashboard polish  ✅

- **EPS independent output control.** Off by default — the whole-unit Power on/off button
  (`action("power_on"/"power_off")`) is a completely separate code path and is unaffected
  either way. When enabled per-EPS in Devices (`independentOutputs: true` + an `outputs`
  array of up to 6 `{ id, label, index }`, `index` 1-6 matching the unit's physical relay),
  each named relay becomes a plain on/off `ZoneState` — its own named row in that EPS's
  dashboard cell (on/off button + live state), a settable row in the preset editor, and a
  target for `POST /api/devices/:id/zones/:zoneId/on`. Protocol: `OUTx_ON`/`OUTx_OFF` per
  relay (`x` = 1-6), `POWER_STATUS`'s `OUTPUTS` field (6 bits, left-to-right = Output 1-6,
  `1`=ON) parsed into per-output state on every poll. Deliberately **no extra security
  tier** for relay control — same access-password gate as everything else, per explicit
  decision (no per-customer need identified yet).
  - **Verified against real production hardware** (a production showroom EPS): `STATE=FULLY_ON`
    and `STATE=OFF` both occur exactly as the existing driver already assumed (powering on
    → `FULLY_ON`, switching one relay off → `PARTIAL_ON` with the `OUTPUTS` bit updating
    correctly, back on → `FULLY_ON` again) — the new Expromo EPS v2.2 protocol doc's own
    `STATE` enum (`IDLE`/`SEQUENCING` only) is incomplete relative to the deployed firmware;
    the codebase's existing assumptions were the correct ones and were not changed to match
    the doc. The `OUTx_ON`/`OUTx_OFF`/`POWER_STATUS`/unknown-command behaviour in the doc
    was also confirmed live and matches exactly.
- **Dark / bright mode switch**, top-right of the toolbar (`ThemeToggle.tsx`). The
  light/dark CSS token system already existed (`styles.css`); this just adds the control.
  Follows the OS theme (no explicit choice stamped) until the operator toggles it once,
  then remembers the explicit choice per-browser in `localStorage` and stamps
  `data-theme` on the root element.
- **Disabling a device hides its dashboard cell entirely** — `startDevices()` now seeds
  `AppState` from `enabled` devices only, instead of including disabled ones as a
  permanently "offline" card.
- **`docs/NETWORK.md`** — the inbound port (the control panel itself, configurable) and
  every outbound connection (each configured device's protocol/port, plus the optional
  HTTPS GitHub update check) documented for customers' IT/AV network reviews.
- **`docs/SECURITY.md`** — the honest security posture for IT/security teams: auth model
  and its real limits (shared password, no RBAC, no per-user audit trail), no-TLS rationale,
  plaintext-secrets-at-rest caveat, unsigned-binary caveat, and a comparison table against
  Bitfocus Companion / typical Crestron-Extron installs / enterprise-tier platforms —
  written to answer "how secure is this" without either overselling or underselling it.
- Test suite 101 → 112 (EPS driver: zone construction, `OUTPUTS`-bit parsing, `setOn`
  dispatch, unconfigured-output rejection; config validation: duplicate output id/index,
  out-of-range index; registry: a disabled device seeds no dashboard card).
- Devices panel polish: the EPS output rows were an auto-fit grid that crammed 3-4 relay
  rows onto one line — now a plain single-column list. Every device card collapses to just
  its header (badge, name, id, host:port, enabled, remove) by default, so opening Devices
  gives an overview instead of a wall of forms. The Cancel/Save footer was `position:
  sticky` inside the scrollable list (could leave a sliver of the next card visible under
  it) — restructured so it's a plain flex sibling entirely outside the scroll region.

## Phase 7 — Settings panel, autostart toggle, presets/scheduler UI fixes  ✅

- **Settings is now its own gear-icon entry in the toolbar**, separate from Devices —
  display name, port, "start when Windows starts", "check for updates", the access
  password, and config backup/diagnostics all moved out of a buried collapsible section
  inside Devices into `SettingsPanel.tsx`. Room to add more app-level settings later
  without further crowding the device editor.
- **"Start when Windows starts" is now a real toggle**, not a fixed install-time decision.
  Backed by Electron's own per-user login item (`app.setLoginItemSettings`, HKCU — no admin
  rights needed at runtime) instead of the installer's old `HKLM…\Run` key (which
  **required elevation to change** and so could never have been a toggle the running app
  flips itself). `installer.nsh` no longer writes that key; the app applies the persisted
  `autoStart` config value (default **on**, matching every install's behaviour before this
  was a toggle) on every launch, and again whenever Settings changes it. The uninstaller
  cleans up both the new HKCU value and the old HKLM one, so upgrading an existing install
  doesn't leave a stale duplicate autostart entry behind.
- **"Check for updates" is now reachable from the web UI**, not just the Electron tray menu
  — `POST /api/updates/check` (new `backend/src/core/updateControl.ts`, same
  registration-callback pattern as `httpControl.ts`'s HTTP restarter) triggers the same
  `autoUpdater.checkForUpdates()` call the tray's own menu item does; the result still
  arrives via the existing `updateInfo` broadcast, so every open browser sees it, not just
  whoever clicked the button.
- **Presets: "Default on startup" moved into the list itself** — a ⭐ toggle button per row,
  instead of only being settable inside Edit. The list also now names which power unit a
  preset defaults for when it isn't "all". Marking a specific EPS's default (rather than
  "any") still needs Edit, since the list toggle is the simple all-power-units case.
- **Scheduler's toolbar button now has a text label**, not just the clock icon.
- Test suite 112 → 116 (`app-settings` name/port/autostart persistence + `portChanged`
  reporting, defaults to `autoStart: true`; `updates/check` reports `triggered: false`
  outside Electron; both new routes added to the "whole surface requires the access
  password" sweep).

## Phase 8 — persisted last-known device state  ✅

- **Problem**: restarting eXcontrol while a controller is unreachable (venue power off, or
  the controller itself down) showed every zone blank — no brightness, no preset names —
  because zone data only ever lived in memory, populated by a successful poll. The "Edit
  preset" dropdown was the sharpest edge: it resolves a saved preset's numeric preset id to
  a name via the live preset list, so with no live list it silently fell back to
  "— preset: leave —", even though the saved preset (and its startup-default configuration)
  were completely intact.
- **Fix**: `backend/src/core/deviceCache.ts` persists each device's last confirmed-online
  zones (brightness, blackout, preset names, EPS relay on/off) and EPS `extra` status
  (SYSTEM/STATE/OUTPUTS) to a `excontrol.device-cache.json` sidecar next to the config,
  debounced to disk, flushed on graceful shutdown. `registry.ts` seeds a device's initial
  state from this cache at boot, before the first poll — so a browser hitting `/api/state`
  the instant eXcontrol starts already sees the last-known picture, not a blank one.
- A driver rebuilding its zone list from scratch (its first successful poll, or after a
  reconnect) only knows fresh identity, not brightness/presets yet — NovaStar's
  `ensureZones()` sends a bare `{ id, label }` before those are read. `state.ts`'s
  `Store.apply()` now merges an incoming zone patch field-by-field onto whatever's already
  known, instead of replacing the zone wholesale, so that bare rebuild can't blank out good
  cached data (only fields the patch *actually sets* win — EPS's `{ on: undefined }`
  placeholder, present but unset, doesn't clobber a cached `true`/`false`).
- Frontend: wherever this last-known data is shown while a device isn't `online`, an orange
  note says so — `PresetsPanel.tsx`'s per-zone preset/scene dropdown ("Preset list is from
  the last known state — offline, not confirmed live") and `DeviceCard.tsx`'s dashboard card
  ("Showing last known configuration — not live while … is unreachable"). New shared
  `.cache-hint` style (`var(--warn)`, the same amber already used for "starting up" states).
- Verified end-to-end with a scratch instance: a device seeded purely from a pre-written
  cache file, host intentionally unreachable — `/api/state` immediately returns cached
  brightness/presets with `status: "offline"`, and both new UI notes render correctly
  (screenshotted via a headless-Chromium smoke test).
- Test suite 116 → 127: `deviceCache.test.ts` (persist/restore across a simulated restart,
  never caches an empty read, prunes removed devices), `state.test.ts` (bare-rebuild merge
  doesn't blank cached fields, explicit-`undefined` doesn't clobber, a genuinely fresh value
  still overwrites, online-only triggers the cache write, EPS `extra` also persists),
  `registry.test.ts` (a freshly booted device shows cached brightness/presets before any
  poll completes).

## Phase 9 — Companion module (developer build, unpublished)  🚧

- **`companion/`** is a Bitfocus Companion module talking to eXcontrol's existing REST API
  (see [`docs/COMPANION.md`](COMPANION.md) for the endpoint table). The ergonomic gap that
  doc's generic-HTTP-module approach has — hand-typing device/zone/preset ids into URLs —
  is gone here: every dropdown (zones, presets, EPS units) is populated live from
  `/api/state` at connect time. Not submitted to Bitfocus's module store — it's loaded via
  Companion's own **Import module package** (a `.tgz`), which is how any developer/unlisted
  module is tested before publishing.
- **Actions**: recall preset/scene, set brightness, blackout on/off/toggle, EPS power
  on/off. **Feedbacks**: preset-is-active, blackout-is-on. Not yet built: independent EPS
  output rows, scheduler actions, live `/ws` push (currently only re-fetches `/api/state` on
  init/config change, not continuously — a button's feedback can go stale between those).
- **Versioning**: pinned to `@companion-module/base@^1.14.0` / `@companion-module/tools@^2.8.0`
  deliberately, not the current `2.x`/`3.x` lines — `@companion-module/base`'s own README
  compatibility table lists Companion v4.3 (the version running on both real test machines)
  as confirmed only through base `v2.0`, and v2.x dropped the `runEntrypoint()` bootstrap
  function entirely, breaking the standard module shape. Re-check that table before bumping
  either package.
- **Packaging gotcha**: a module `.tgz` for Companion's "Import module package" must have
  `companion/manifest.json` as its **first tar entry**, not nested under a wrapping
  directory the way `npm pack` produces (`package/companion/manifest.json` fails with
  "missing manifest" — confirmed by reading Companion's own bundled `main.js`, not
  documented anywhere obvious). `@companion-module/tools`' `companion-module-build --dev`
  produces a correctly-shaped package; don't hand-rustle `.tgz`s again.
- **Bug found + fixed on real hardware**: `apiFetch()` unconditionally sent
  `content-type: application/json`. eXcontrol's Fastify backend rejects that header on a
  request with an empty body (`FST_ERR_CTP_EMPTY_JSON_BODY`) — every action that sends a
  real JSON body (recall preset, set brightness/blackout) worked fine; EPS power on/off
  (which takes no body) always 400'd. Only attach that header when a body is actually
  present. Found via Companion's own connection log on a live production showroom instance —
  OBS scene recall (has a body) worked, EPS power (no body) didn't, exactly matching the
  fault line. Fixed in `v0.0.2`.
- **Validated against real infrastructure, not just CBLATest**: this module was built,
  imported, connected (green "OK", live `/api/state` data populating every dropdown), and
  bug-fixed against a real production showroom's Companion instance — the same box already
  driving real Stream Deck buttons for the room via the official NovaStar modules. A
  deliberately empty button slot was used for the eXcontrol test action; nothing else on
  that Stream Deck's existing pages was touched. Both live-fire tests have now passed: OBS
  scene recall (targeting the already-active scene, so no visible effect) and, after the
  `v0.0.2` fix, EPS power on/off for real.
- **Known gap**: no LICENSE file in the package (`companion-module-build`'s license-inventory
  check warns but doesn't fail) — cosmetic, add one before considering publishing.
  *(Fixed — `companion/LICENSE` added; the tool's own remaining warning is about
  `@companion-module/base`'s upstream package lacking one, not ours.)*

## Phase 10 — Expromo eXview Edge/AIO driver  ✅

- **`backend/src/drivers/exview.ts`** — the first UDP-based driver in this codebase (every
  other one is HTTP or TCP). Protocol reverse-engineered from the
  `exview-aio-driver-wiki`/`expromo-exview-edge-crestron` GitHub repos: UDP port 8600, a
  fixed 40-byte frame (seven `0x55` sync bytes, a 2-byte command code, 17 bytes of `0xFF`
  padding, a length-prefixed payload, a trailing checksum = sum of bytes[8..end-1] & 0xFF).
  The frame builder/parser was validated against all 106 documented command examples before
  writing a single line against real hardware — 100/106 matched byte-for-byte (the other 6
  are pre-existing data-entry inconsistencies in the source spreadsheet, none touching the
  four commands this driver uses).
- **One device type, two models**: `exview` with `model: "edge" | "aio"` — same protocol,
  Edge exposes HDMI1-2 as presets, AIO exposes HDMI1-4 (the wire value for HDMI4 is `0x06`,
  not `0x05` — confirmed both from the spec and from real hardware; `0x05` is simply unused).
  On/off, brightness, and volume all map onto the existing `ZoneState` shape — `volume` is a
  new field there (and on `PresetAction`), everything else (brightness, presets, `on`)
  already existed and just needed a new device type to use them together on one zone, which
  no existing driver had done before.
- **On/off deliberately maps to the protocol's quick "Sleep/Wake" toggle (0xC003), not the
  deep Standby/Restart (0xC007/0xC009)** — the Crestron module's own field notes (real
  install experience, not just the protocol doc) flag that the deep path reboots the unit
  into a restricted state that only answers two commands for ~25s, and that volume/
  brightness/source queries return a fixed error frame while in it, indistinguishable from
  a real fault. The quick toggle keeps the unit fully pollable and reachable either way,
  which is what this app's poll-driven status model needs — matches "day-to-day screen
  on/off", not "unplug it."
- **A real bug found only on real hardware**: the Power ack (0xC004) turned out to echo the
  sent byte back (1 byte), not the 2-byte success/failure status word every other Set
  command's ack uses — the driver originally (wrongly) checked it the same way as the
  others, so every real power command looked "rejected" even though the device was doing
  exactly what was asked. Fixed once discovered; the unit test's fake server was also
  carrying the same wrong assumption and got corrected alongside it.
- **Verified end-to-end against a real eXview Edge unit**, not just the fake-server unit
  tests: probe, a full poll cycle, brightness, volume, both HDMI inputs, and power on/off —
  each confirmed by reading the value back from the device afterward, not just trusting the
  ack. The device was returned to its exact starting state (on, volume 25, brightness 100,
  Android source) when finished.
- Setup wizard: a Model dropdown (Edge/AIO) appears for this device type, same place EPS's
  independent-output toggle lives.
- Test suite 136 total (9 new): zones-by-model, real documented TX bytes for volume, power
  on/off byte selection + ack handling, HDMI recall (including rejecting an input the
  current model doesn't expose), a full poll cycle from real reply-shaped frames, and probe
  success/timeout.
- **Not done**: this new device type isn't wired into the Companion module (Phase 9) or the
  subnet auto-discovery scan — out of scope for what was asked, straightforward to add later
  following the same pattern as the other device types in each.

## Phase 11 — eXview: Android source, HDMI signal indicator, and the real On/Blackout/Standby model  ✅

- **Android added as a selectable source** alongside the model's HDMI inputs, on both Edge
  and AIO — it's the unit's built-in OS, not a cable input.
- **Per-input signal-presence indicator** (0xC25B, polled every cycle) — each HDMI preset
  button now carries `hasSignal`, independent of which input is selected. Mirrors the
  Crestron module's per-port `Active_Fb` outputs. `Preset` is a shared type (NovaStar/OBS
  use it too); this is a new optional field those simply never set.
- **The device has three real power states, not two — On / Blackout / Standby — and
  distinguishing the last two needs two queries combined, not one.** This came from reading
  three of the user's other repos, not from re-deriving it live: the full 106-command
  protocol reference (`exview-aio-driver-wiki`), a real field-deployed Crestron SIMPL+
  module (`expromo-exview-edge-crestron`), and a Tauri desktop tool's own session notes
  (`exview-control`'s `PROJECT_SNAPSHOT.md`) — the last of which documents a **real bug in
  that tool's own `resolvePowerState()`**, deliberately not repeated here.
  - Blackout (0xC003, data `0x5F`) is instant and reversible — the unit stays fully
    responsive. But a **prolonged Blackout auto-transitions into a restricted Standby on its
    own** (the timeout is a setting on the device itself — the user's unit has it at 5
    minutes — invisible to any control software until it happens). The same restricted state
    is also reachable directly via `0xC007`.
  - In that restricted state, `0xC005` (the plain sleep/wake query used to distinguish
    On/Blackout) either gets no reply at all, or gets replied to with a completely different,
    **non-framed reply**: the literal ASCII text `"Unsupported protocol"`. There's a second
    query, `0xC020` ("true/fake standby"), whose own reply is not reliable alone either — the
    bug in the reference tool was trusting `0xC020 == 1` as sufficient proof of Standby
    without checking whether `0xC005` had *also* stopped answering normally. **Fixed here by
    querying both every cycle and combining them**: either coming back as the
    `"Unsupported protocol"` text means Standby, full stop; failing that, `0xC005` timing out
    completely while `0xC020 == 1` also means Standby; otherwise `0xC005`'s own byte
    (`0x80`/`0x00`) decides On vs Blackout, and total silence from *both* queries is treated
    as a genuine connectivity failure (`offline`, same as any other driver), not a fourth
    silent power state.
  - Volume/brightness/source/HDMI-signal are skipped entirely while Standby is detected —
    they'd only come back as the same unsupported-protocol text.
  - **Waking from Standby needs a completely different, undocumented-in-the-command-table
    packet**: `AA BB CC 01 00 00 01 DD EE FF` — 10 raw bytes, no sync preamble, no checksum,
    no reply. The ordinary `0xC003` wake byte is exactly the "everything else" Standby
    rejects. The driver tracks the last resolved power state and picks the right one
    automatically — Blackout's plain wake byte, or Standby's (and initial-Unknown's) special
    packet — so `setOn(true)` behaves correctly regardless of which state it's actually
    waking from.
  - New `ZoneState.powerState?: "on" | "blackout" | "standby"` surfaces this in the API/UI —
    richer than the existing plain `on` boolean (still populated, true only for "on"). The
    dashboard's on/off button now shows three distinct labels/colors instead of two, with a
    dedicated amber "Standby — tap to wake" state.
- **Verified end-to-end against real hardware, including the full ~30-70s standby/wake
  cycle**: triggered real Standby via `0xC007` (the direct path — verified equivalent to
  what a genuinely long Blackout eventually reaches on its own) and watched the driver
  correctly report **no power state at all during the device's own unreachable reboot
  window**, then **Standby** once it settled, persisting indefinitely as documented. Then
  called the real `setOn(true)` and watched it send the dedicated wake packet and the device
  recover to fully **On** with every prior setting (volume, brightness, HDMI input) intact —
  confirming the whole detection *and* recovery path against a real unit, not just the
  fake-server test suite (21 tests, `exview.test.ts`, including dedicated regression
  coverage for the exact reference-tool bug described above).
- **Cosmetic fix**: the on/off button borrowed blackout's black/red "alert" styling, which
  reads backwards for a plain "screen is on" state in light mode especially — now a
  theme-aware green-on/amber-standby/normal-off treatment.

## Phase 12 — eXview: real-hardware auto-timeout capture, stale-reading fix, and smart transition messaging  ✅

Phase 11 verified the On/Blackout/Standby model against a **direct `0xC007`-triggered**
Standby entry only. Real usage goes through Blackout's own **device-configured auto-timeout**
instead, and that path exposed two problems Phase 11 didn't catch:

- **Real hardware capture**: a 7-minute scripted probe (Blackout, then all six relevant
  queries every 20s) against the user's live unit caught the actual auto-escalation in the
  act — a ~20s stretch where *every* query, `0xC020`/`0xC005` included, got no reply
  whatsoever, immediately followed by the unit settling into the same `"Unsupported protocol"`
  Standby signature Phase 11 already knew about. (Also notable, though not something the
  driver needs to act on: the user's unit escalated after roughly 2.5 minutes of this run, not
  the ~5 minutes previously described — device-side timers apparently aren't exactly fixed.)
- **Bug: stale volume/brightness/source/signal shown as if live during Standby.** Phase 11's
  `poll()` deliberately left these fields untouched while Standby/Unknown, reasoning that
  "keep the last known value" was the friendlier default (same convention `BaseDriver` uses
  across a real disconnect). Live-hardware testing showed this was wrong for this specific
  case: a screen that's been in Standby for hours still shows whatever HDMI input last had a
  cable plugged in, looking exactly as live and current as real data. **Fixed**: entering
  Standby (or the rarer Unknown case) now explicitly blanks `volume`, `brightness`,
  `activePreset`, and every preset's `hasSignal`, via a new `clearLiveReadings()` — the section
  still renders (so the source list doesn't disappear), just without any dot or value claiming
  to know something it can't.
- **Bug: the ~20-70s unreachable reboot window reported a bare "Offline" fault.** Technically
  true (nothing replies), but not useful — the user wants to see "switching to standby" or
  "waking up" for a stretch of unreachability that's an *expected part of a transition already
  underway*, distinct from an actual connectivity fault. `resolvePowerState()` now returns an
  `"unreachable"` state instead of throwing; `poll()` tracks `unreachableSince` and an
  `awaitingWake` flag (set the moment `setOn(true)` sends the Standby wake packet) and reports
  via `BaseDriver.initializing()` — "waking up from standby" or "switching to standby" —
  whenever the current unreachable stretch follows a Blackout, a Standby, or our own wake
  attempt, for up to 90s (comfortably past the ~70s worst case seen on real hardware).
  Unreachability with no such preceding context — or one that's gone on far longer than any
  real reboot takes — still reports as a genuine fault (`offline()`), same as any other driver.
  The frontend surfaces the specific note (capitalized) instead of the generic "Booting…" text,
  scoped to `device.type === "exview"` only so no other driver's raw connectivity-error
  messages start leaking into their own generic initializing text.
- Added 4 new tests to `exview.test.ts` (25 total): stale-reading clearing, the
  Blackout-then-total-timeout "switching to standby" path, the wake-then-total-timeout "waking
  up" path, and a control case confirming a first-ever, context-less unreachable spell still
  reports as a genuine fault immediately (not swallowed into "initializing" indefinitely).
- **Operational note, not a code lesson**: mid-fix, the live test instance running on the
  user's PC turned out to be a plain `node backend/dist/cli.js` process, not the installed
  Electron app — restarting it to pick up the fix without first confirming that killed the
  user's in-progress session, and its config/data directory couldn't be reconstructed
  afterward (it wasn't in the usual `%ProgramData%\eXcontrol` Electron path — that held an
  older, unrelated instance). Lesson for next time: confirm exactly how a live test process is
  running and where its data lives *before* restarting it, not after.
- **Follow-up**: real-hardware retest surfaced one more gap — after pressing "On — tap to
  turn off," the resulting "Blackout — tap to turn on" label is accurate but doesn't warn that
  the device will auto-escalate into Standby on its own after its configured timeout. Added a
  muted hint under the power button, shown only while `powerState === "blackout"`: "Screen
  will go into standby mode after the pre-configured time."

## Known gaps / decisions pending

- Default Electron icon everywhere (taskbar, tray, installer) — needs artwork.
- Subnet scan sweeps every LAN interface incl. Tailscale/virtual adapters (harmless, just
  slower and noisier than scoping to real LANs only).
- TLS: deliberately not done — plain HTTP on a trusted LAN, per the network-model note in
  the README.
- Multi-EPS: covered by simulation tests, never run on real multi-unit hardware.
- Independent output control: verified against one real EPS unit; multiple EPS units each
  with independent outputs enabled is simulation-tested only.

## Not planned

- Code signing (later).
- Remote-support tooling.
- Multi-site in one process.
