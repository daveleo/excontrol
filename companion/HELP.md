# eXcontrol — Companion module (developer build, unpublished)

Not submitted to Bitfocus's module list yet. Loaded via Companion's own **Import module
package** button (Modules page), not the module store, not a "point at a folder" dev-path
setting — Companion v4.3 has no such setting; don't waste time looking for one.

## Build + install

```bash
npm install
node node_modules/@companion-module/tools/scripts/build-connection.js --dev
```

This produces `excontrol-<version>.tgz` (via `@companion-module/tools`, which produces a
correctly-shaped package — don't hand-build a tarball with `tar`/`npm pack`, see the gotcha
below). In Companion: **Modules → Import module package** → pick that `.tgz`. Then
**Connections → Add Connection**, search "excontrol", add it. If a connection already
exists on an older version, open it → the pencil icon next to "Module Version" → pick the
new version → Save (no need to delete and re-add).

## Version pins — don't casually bump these

`package.json` pins `@companion-module/base@^1.14.0` and `@companion-module/tools@^2.8.0`
**deliberately**. `@companion-module/base`'s own README compatibility table lists Companion
v4.3 as confirmed only through base `v2.0`; the `2.x` line also **removed `runEntrypoint()`**
(the function this module's `main.js` calls at the bottom to bootstrap), which breaks the
whole module at import/runtime with no build-time warning. If bumping either package,
re-check that compatibility table first and confirm `runEntrypoint` still exists:
`node -e "console.log(typeof require('@companion-module/base').runEntrypoint)"`.

## Packaging gotcha

A raw `.tgz` built by hand (or by plain `npm pack`, which wraps everything in a `package/`
prefix) will fail Companion's import with **"Doesn't look like a valid module, missing
manifest"**, even with the exact right files present. Confirmed by reading Companion's own
bundled `main.js` (not documented anywhere obvious): the importer needs
`companion/manifest.json` to be the tar's first directory-prefixed entry — exactly what
`companion-module-build` already produces. Always build via that tool, never by hand.

## What it talks to

Same REST API documented in the main repo's `docs/COMPANION.md` — `/api/state` for the live
device/zone/preset list (populates every dropdown here), `/api/devices/:id/zones/:zoneId/*`
for brightness/preset/blackout, `/api/power/:target/:onoff` for EPS power.

## Status (v0.0.2)

Actions: recall preset/scene, set brightness, blackout on/off/toggle, EPS power on/off.
Feedbacks: preset-is-active, blackout-is-on. Verified against a real production showroom's
Companion instance (not just a test rig) — connection shows green "OK", every dropdown
populates from real device data.

`v0.0.1` had a real bug, found on that hardware and fixed in `v0.0.2`: `apiFetch()`
unconditionally sent `content-type: application/json`, which eXcontrol's Fastify backend
rejects on a request with an empty body. Every action with a real JSON body (preset, scene,
brightness, blackout) worked fine; EPS power on/off (no body) always 400'd. Fixed by only
attaching that header when a body is actually present.

Both live-fire tested and passing: OBS scene recall, and EPS power on/off after the
`v0.0.2` fix.

Not yet built: independent EPS output rows, scheduler actions, live `/ws` push (currently
only re-fetches `/api/state` on init/config change, not continuously — a button's feedback
can go stale between those), a LICENSE file (packaging warns about its absence).
