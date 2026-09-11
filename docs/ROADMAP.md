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

## Known gaps / decisions pending

- Default Electron icon everywhere (taskbar, tray, installer) — needs artwork.
- Subnet scan sweeps every LAN interface incl. Tailscale/virtual adapters (harmless, just
  slower and noisier than scoping to real LANs only).
- TLS: deliberately not done — plain HTTP on a trusted LAN, per the network-model note in
  the README.
- Multi-EPS: covered by simulation tests, never run on real multi-unit hardware.
- No GitHub Release published yet — Phase 4's one remaining step (see above).

## Not planned

- Per-EPS-output control (no protocol yet — the schema leaves room).
- Code signing (later).
- Remote-support tooling.
- Multi-site in one process.
