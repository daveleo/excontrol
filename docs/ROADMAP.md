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
- **Needs one remaining manual step**: nothing here creates a GitHub Release. Tag a
  version (`git tag vX.Y.Z && git push --tags`) and either publish by hand
  (`cd desktop && npx electron-builder --publish always`, needs a `GH_TOKEN`) or add a
  release workflow — not set up yet. Until a release exists, checks correctly report
  "No published versions on GitHub" (verified — see below).

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
  - **Verified against real production hardware** (the Aarhus showroom EPS): `STATE=FULLY_ON`
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
- Test suite 101 → 112 (EPS driver: zone construction, `OUTPUTS`-bit parsing, `setOn`
  dispatch, unconfigured-output rejection; config validation: duplicate output id/index,
  out-of-range index; registry: a disabled device seeds no dashboard card).

## Known gaps / decisions pending

- Default Electron icon everywhere (taskbar, tray, installer) — needs artwork.
- Subnet scan sweeps every LAN interface incl. Tailscale/virtual adapters (harmless, just
  slower and noisier than scoping to real LANs only).
- TLS: deliberately not done — plain HTTP on a trusted LAN, per the network-model note in
  the README.
- Multi-EPS: covered by simulation tests, never run on real multi-unit hardware.
- Independent output control: verified against one real EPS unit; multiple EPS units each
  with independent outputs enabled is simulation-tested only.
- No GitHub Release published yet — Phase 4's one remaining step (see above).

## Not planned

- Code signing (later).
- Remote-support tooling.
- Multi-site in one process.
