# Power: how eXcontrol turns things on and off

This is the reference for the power model introduced in v0.3.0 (engine) and v0.3.1 (UI).
Code: `backend/src/core/groups.ts` (engine), `backend/src/core/power.ts` (per-EPS domains,
output ownership), `backend/src/drivers/eps.ts`, `backend/src/drivers/exview.ts`,
`frontend/src/lib/status.ts` (what the UI calls each state).

## Concepts

| Concept | What it is |
|---|---|
| **EPS unit** | An Expromo EPS power sequencer: 6 zero-cross relays ("outputs"). Infrastructure, not something an operator switches directly. |
| **Output ownership** | A device with `poweredByOutput: N` owns output N of its EPS. Devices without it ("whole unit") share every output no other device claims. A device with no `poweredBy` is on its own socket. |
| **Protected output** | `outputs[].protected` — never switched off by whole-unit power off, groups or schedules (network switch, control PC). Its own button in Power › Details still works. |
| **Group** | A named set of devices (`config.groups`) with a target: **On**, **Standby** or **Off**. |
| **Room / Everything** | The built-in group of every device, shown under the room's display name (Setup › System). The power bar controls it. |
| **Target** | What a group (or device) should be. Targets are set by the power bar, a group row, a schedule entry or the API — the engine then carries them out. |

## Who decides a device's state

1. The room-wide group **passes its target down**: setting it sets every group too.
2. A device in several groups follows the **highest** target among them — On beats Standby
   beats Off. Switching one group off never cuts something another group still wants on.
3. A device in no group follows the room-wide target.
4. A command on the device's **own card** overrides its groups until one of them next changes
   (and means "switched on after its scheduled off" isn't reported as a surprise).

## What On / Standby / Off mean per device

| Device | On | Standby | Off |
|---|---|---|---|
| Anything on an EPS | its output(s) on, then (eXview) woken / (NovaStar) un-blacked | power stays on; eXview → Standby, NovaStar → black | **its output is switched off — the EPS decides**, no soft step first |
| eXview on its own socket | wake packet / 0xC003 on | 0xC007 deep Standby | same as Standby (nothing to cut) |
| NovaStar on its own socket | un-black | black | black |
| Off device whose output another device still needs | — | — | stays powered; blacked out / Standby instead, and its card says who it's kept on for |

Outputs that no configured device depends on (a spare unit, passive loads) follow **only**
the room-wide target. A group never touches them.

## Order of work (one run of the engine)

1. **Soft off** — Standby / black for the devices that need it.
2. **Switch-offs** — EPS units in reverse order. Zero-cross relays switch off at current
   zero, so switching off needs no stagger — it needs *order* (screens first).
3. **Switch-ons** — one EPS unit at a time with a 1 s gap (one inrush at a time). From fully
   off the unit's own sequence is used; otherwise only the missing outputs, 300 ms apart.
4. **Wait** for equipment to come online (up to 4 min each), then **wake** screens, 2 s apart.

The engine is edge-triggered: it acts when a target changes. If something is switched back
on afterwards (a remote, another controller), a pop-up reports it — nothing is fought.

## EPS driver: built around the measured firmware (v2.2)

Measured on real hardware:

- POWER_ON: 1 s start delay, then one relay every ~303 ms; FULLY_ON at ~2.6 s.
- POWER_OFF: all six at once.
- POWER_ON on a **partly-on** unit first switches everything off, then re-sequences —
  running equipment loses power for ~1 s. **The driver never sends POWER_ON unless the unit
  is fully off**; otherwise it switches on only the missing outputs.
- An OUTx command during a sequence **aborts** the sequence. The driver waits it out.
- Two TCP connections at once can make the unit **drop commands** and then ignore
  everything for ~10 s. The driver uses one connection at a time, polls step aside while a
  command runs, and every command is **verified by reading status back and retried**.
  Other controllers may still talk to the unit directly; the retry is what keeps a
  collision with them from losing a command.
- A **minimum off-time** (default 30 s, `minOffSeconds`) before an output is switched back
  on — protects NTC inrush limiters and avoids hard-cycling processors and Android screens.
- An EPS is reported "not responding" only after 3 missed polls.

## Schedule

- Entries target the room (`"all"`), a group (`"group:<id>"`) or a single EPS (its id —
  whole-unit power, the pre-0.3 behaviour). Actions: `power_on`, `standby`, `power_off`,
  `apply_preset` (a scene).
- **Extending** a shutdown (+1 hour) applies to that one entry: only it is held back, and
  only its own target fires when the extension runs out. (Before 0.3 it fired "all".)
- The 15-minute warning and the power bar name what will switch off.

## API

| Action | Method | Path | Body |
|---|---|---|---|
| Room / group On · Standby · Off | POST | `/api/groups/<id>/state` (`all` = the room) | `{"state": "on" \| "standby" \| "off"}` |
| List / save groups | GET / PUT | `/api/groups` | PUT: `{"groups": [...]}` |
| eXview On · Black · Standby | POST | `/api/devices/<id>/zones/-/power` | `{"state": "on" \| "blackout" \| "standby"}` |
| Whole EPS unit on / off (safe) | POST | `/api/power/<eps-id>/on` · `/off` | — |
| Room on / off (same as the power bar) | POST | `/api/power/all/on` · `/off` | — |
| Dismiss a pop-up | POST | `/api/alerts/<id>/dismiss` (`all` for every one) | — |

`GET /api/state` carries `groups` (with target, who set it, progress, summary),
`deviceTargets` (per device: target, which group decided, and `heldBy` when it's kept on for
another device) and `alerts`.

## Not yet

Nested groups, per-circuit "feeds" (all units are chained today), exception dates and
catch-up of a schedule missed while eXcontrol was down, group actions in the Companion
module, per-surface scoping. Group targets are not persisted across a restart — after a
restart they read "not set" until the next change; nothing is switched at startup.
