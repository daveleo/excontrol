# eXcontrol — Companion module (developer build, unpublished)

Not submitted to Bitfocus's module list. Load it via Companion's own **Developer modules**
path setting (Settings → Developer modules → add this folder), not the module store.

## Setup

1. `npm install` inside this folder.
2. In Companion: Settings → Developer modules → add the path to this folder → Companion
   picks up `companion/manifest.json` and hot-reloads on changes to `main.js`.
3. Add a new connection → eXcontrol → set host/port (and access password, if one is set in
   eXcontrol's own Settings).

## What it talks to

Same REST API documented in the main repo's `docs/COMPANION.md` — `/api/state` for the live
device/zone/preset list (populates every dropdown here), `/api/devices/:id/zones/:zoneId/*`
for brightness/preset/blackout, `/api/power/:target/:onoff` for EPS power.

## Status

First working draft — recall preset/scene, set brightness, blackout on/off/toggle, EPS
power on/off, plus "preset is active" and "blackout is on" feedbacks. Not yet: independent
EPS output rows, scheduler actions, live `/ws` push (currently re-fetches `/api/state` only
on init/config change, not continuously).
