import { randomUUID } from "node:crypto";
import type {
  DeviceState, DeviceTarget, GroupConfig, GroupState, PowerAlert, PowerTarget,
} from "@excontrol/shared";
import { ALL_GROUP } from "@excontrol/shared";
import { getConfig, saveConfig } from "../config.js";
import { store } from "./state.js";
import { bus, toast } from "./bus.js";
import { getDriver } from "./registry.js";
import { outputOwnership } from "./power.js";
import { log } from "../logger.js";

/**
 * The power engine: power groups, and the one place that turns "this group should be On /
 * Standby / Off" into commands.
 *
 * Resolution (pure, see resolveTargets):
 *  - "Everything" (ALL_GROUP) passes its target down: setting it sets every group too.
 *  - A device in several groups follows the *highest* target among them — on beats standby
 *    beats off. Turning one group off never pulls the plug on something another group
 *    still wants on.
 *  - A device in no group follows Everything.
 *  - A manual command on the device itself (its card, its EPS's buttons) overrides until
 *    one of its groups next changes.
 *
 * Power (pure, see planEpsOutputs): a device on an EPS output owns that relay; "whole unit"
 * devices share every unclaimed relay. A relay goes off only when every device on it is
 * Off, and a device whose relay has to stay on for someone else is blacked out / put in
 * standby instead. Protected relays are never switched off.
 *
 * Execution (reconcile): soft-off (standby, blackout) → switch-offs → switch-ons chained
 * unit by unit (one inrush at a time, the unit's own sequence where possible, gap between
 * units) → wait for the equipment → soft-on (wake, un-blackout), staggered.
 *
 * It's edge-triggered: the engine acts when a target changes, not continuously. If someone
 * switches something back on afterwards, it's reported (an alert), not fought.
 */

const RANK: Record<PowerTarget, number> = { off: 0, standby: 1, on: 2 };
const LABEL: Record<PowerTarget, string> = { on: "On", standby: "Standby", off: "Off" };

/** timings — overridable in tests */
export const _engineTiming = { unitGapMs: 1000, wakeStaggerMs: 2000, bootWaitMs: 240_000, pollMs: 1000 };

type Kind = "eps" | "power-only" | "exview" | "novastar" | "none";
type Dev = Pick<DeviceState, "id" | "type" | "label" | "poweredBy" | "poweredByOutput">;

function kindOf(d: Dev): Kind {
  if (d.type === "expromo-eps") return "eps";
  if (d.type === "exview") return "exview";
  if (d.type === "novastar-h" || d.type === "novastar-coex") return "novastar";
  return d.poweredBy ? "power-only" : "none";
}

/** Can the engine do anything at all to this device? */
export function isControllable(d: Dev): boolean {
  const k = kindOf(d);
  return k === "exview" || k === "novastar" || k === "power-only";
}

export interface Resolved {
  target?: PowerTarget;
  via: string[];
  manual?: boolean;
}

/** Pure. Which target each controllable device should be at, and which group(s) decided. */
export function resolveTargets(
  devices: Dev[],
  groups: GroupConfig[],
  targets: Map<string, PowerTarget>,
  manual: Map<string, PowerTarget> = new Map(),
): Map<string, Resolved> {
  const out = new Map<string, Resolved>();
  for (const d of devices) {
    if (!isControllable(d)) continue;
    const m = manual.get(d.id);
    if (m) {
      out.set(d.id, { target: m, via: ["manual"], manual: true });
      continue;
    }
    let best: PowerTarget | undefined;
    let via: string[] = [];
    for (const g of groups) {
      if (!g.members.includes(d.id)) continue;
      const t = targets.get(g.id);
      if (!t) continue;
      if (best === undefined || RANK[t] > RANK[best]) {
        best = t;
        via = [g.label];
      } else if (t === best) via.push(g.label);
    }
    if (best === undefined) {
      const all = targets.get(ALL_GROUP);
      if (all) {
        best = all;
        via = ["Everything"];
      }
    }
    out.set(d.id, { target: best, via });
  }
  return out;
}

/** Pure. Desired state per relay (index 0 = OUT1; undefined = leave alone) for one EPS,
 *  plus which Off devices have to stay powered because someone else needs their relay. */
export function planEpsOutputs(
  members: Dev[],
  targetOf: (id: string) => PowerTarget | undefined,
  protectedOutputs: Set<number> = new Set(),
): { desired: (boolean | undefined)[]; heldOn: Map<string, string[]> } {
  const { claimed, whole, rest } = outputOwnership(members);
  const desired: (boolean | undefined)[] = Array(6).fill(undefined);
  const wants = (t: PowerTarget | undefined) => (t === undefined ? undefined : t !== "off");
  for (const [idx, id] of claimed) desired[idx - 1] = wants(targetOf(id));
  const heldOn = new Map<string, string[]>();
  if (whole.length) {
    const ts = whole.map((id) => targetOf(id));
    const anyOn = ts.some((t) => t !== undefined && t !== "off");
    const allOff = ts.every((t) => t === "off");
    const v = anyOn ? true : allOff ? false : undefined;
    for (const i of rest) desired[i - 1] = v;
    if (anyOn) {
      const keepers = whole.filter((id) => wants(targetOf(id)));
      for (const id of whole) if (targetOf(id) === "off") heldOn.set(id, keepers);
    }
  }
  for (const p of protectedOutputs) if (desired[p - 1] === false) desired[p - 1] = undefined;
  return { desired, heldOn };
}

/* ---------------- runtime ---------------- */

interface TargetRec { target: PowerTarget; setBy: string; setAt: number }
const targets = new Map<string, TargetRec>();
const manual = new Map<string, PowerTarget>();
/** NovaStar zones the engine blacked out — un-blacked on the way back to On */
const engineBlackout = new Set<string>();
let alerts: PowerAlert[] = [];
const lastObservedOn = new Map<string, boolean>();

let chain: Promise<void> = Promise.resolve();
let generation = 0;
let busy = false;
let progress: string | undefined;
/** devices the current step is working on — a group shows the progress line only if one
 *  of its own members is involved (so "Screens" doesn't say "Waiting for H9") */
let progressDevices = new Set<string>();
let started = false;

function groupsCfg(): GroupConfig[] {
  return getConfig().groups ?? [];
}

function resolveNow(): Map<string, Resolved> {
  const t = new Map<string, PowerTarget>();
  for (const [k, v] of targets) t.set(k, v.target);
  return resolveTargets(store.all(), groupsCfg(), t, manual);
}

/* ---- observed state, for summaries and drift ---- */

type Observed = "on" | "standby" | "blackout" | "off" | "offline" | "starting";

function observe(d: DeviceState): Observed {
  if (d.status === "powered-off") return "off";
  if (d.status === "initializing" || d.status === "connecting") return "starting";
  if (d.status !== "online") return "offline";
  if (d.type === "exview") {
    const ps = d.zones[0]?.powerState;
    return ps === "standby" ? "standby" : ps === "blackout" ? "blackout" : "on";
  }
  if (d.type === "novastar-h" || d.type === "novastar-coex") {
    return d.zones.length && d.zones.every((z) => z.blackout) ? "blackout" : "on";
  }
  return "on";
}

function summarize(ids: string[]): string {
  const counts = new Map<Observed, number>();
  for (const id of ids) {
    const d = store.get(id);
    if (!d) continue;
    const o = observe(d);
    counts.set(o, (counts.get(o) ?? 0) + 1);
  }
  const order: Observed[] = ["on", "starting", "blackout", "standby", "off", "offline"];
  const parts = order.filter((o) => counts.get(o)).map((o) => `${counts.get(o)} ${o}`);
  return parts.join(" · ") || "no devices";
}

function effectFor(d: DeviceState, r: Resolved, held: Map<string, string[]>): string | undefined {
  if (!r.target) return undefined;
  const k = kindOf(d);
  const out = d.poweredByOutput ? `output ${d.poweredByOutput}` : "its outputs";
  const eps = d.poweredBy ? store.get(d.poweredBy)?.label ?? d.poweredBy : undefined;
  const keepers = held.get(d.id);
  if (r.target === "off" && keepers?.length) {
    const names = keepers.map((id) => store.get(id)?.label ?? id).join(", ");
    return `power stays on — ${eps} ${out} also feeds ${names} (still wanted on), so ${k === "exview" ? "standby" : "blacked out"} instead`;
  }
  if (d.poweredBy) {
    if (r.target === "off") return `${eps}: ${out} switched off`;
    if (r.target === "standby") return `${eps} stays on · ${k === "exview" ? "standby" : k === "novastar" ? "blacked out" : "no standby for this device"}`;
    return `${eps}: ${out} on${k === "exview" ? " · screen woken" : ""}`;
  }
  if (k === "exview") return r.target === "on" ? "woken / on" : "standby (0xC007)";
  if (k === "novastar") return r.target === "on" ? "shown (blackout released)" : "blacked out";
  return undefined;
}

let publishQueued = false;
function publish(): void {
  if (publishQueued) return;
  publishQueued = true;
  queueMicrotask(() => {
    publishQueued = false;
    publishNow();
  });
}

function heldMap(res: Map<string, Resolved>): Map<string, string[]> {
  const devices = store.all();
  const held = new Map<string, string[]>();
  for (const eps of devices.filter((d) => d.type === "expromo-eps")) {
    const members = devices.filter((d) => d.poweredBy === eps.id);
    const { heldOn } = planEpsOutputs(members, (id) => res.get(id)?.target);
    for (const [k, v] of heldOn) held.set(k, v);
  }
  return held;
}

function publishNow(): void {
  const devices = store.all();
  const res = resolveNow();
  const held = heldMap(res);
  const controllable = devices.filter(isControllable).map((d) => d.id);
  const mk = (id: string, label: string, members: string[]): GroupState => {
    const t = targets.get(id);
    const active = busy && members.some((m) => progressDevices.has(m));
    return {
      id, label, members,
      target: t?.target, setBy: t?.setBy, setAt: t?.setAt,
      busy: active,
      progress: active ? progress : undefined,
      summary: summarize(members),
    };
  };
  const groups = [
    mk(ALL_GROUP, "Everything", controllable),
    ...groupsCfg().map((g) => mk(g.id, g.label, g.members.filter((m) => devices.some((d) => d.id === m)))),
  ];
  const deviceTargets: DeviceTarget[] = [];
  for (const d of devices) {
    const r = res.get(d.id);
    if (!r) continue;
    deviceTargets.push({ deviceId: d.id, target: r.target, via: r.via, manual: r.manual, effect: effectFor(d, r, held) });
  }
  store.setGroups(groups, deviceTargets);
}

function setProgress(p: string | undefined, deviceIds: string[] = []): void {
  progress = p;
  progressDevices = new Set(deviceIds);
  publish();
}

/* ---- public API ---- */

export function knownGroup(id: string): boolean {
  return id === ALL_GROUP || groupsCfg().some((g) => g.id === id);
}

/** Set a group's target and carry it out. Resolves once queued — progress is published. */
export function setGroupTarget(id: string, target: PowerTarget, setBy: string): Promise<void> {
  if (!knownGroup(id)) return Promise.reject(new Error(`no power group "${id}"`));
  const rec = { target, setBy, setAt: Date.now() };
  if (id === ALL_GROUP) {
    targets.set(ALL_GROUP, rec);
    for (const g of groupsCfg()) targets.set(g.id, rec); // Everything passes its target down
    manual.clear();
  } else {
    targets.set(id, rec);
    for (const m of groupsCfg().find((g) => g.id === id)?.members ?? []) manual.delete(m);
  }
  const label = id === ALL_GROUP ? "Everything" : groupsCfg().find((g) => g.id === id)?.label ?? id;
  log.info({ group: id, target, setBy }, "power group target set");
  toast("info", `${label} → ${LABEL[target]}`);
  return runReconcile([id]);
}

/** A device-level command from its own card: it now overrides its groups until they change. */
export function noteManual(deviceId: string, target: PowerTarget): void {
  const d = store.get(deviceId);
  if (!d || !isControllable(d)) return;
  manual.set(deviceId, target);
  lastObservedOn.set(deviceId, target === "on");
  publish();
}

/** The EPS card's own Power on/off: everything on that unit is now manually on/off. */
export function noteEpsManual(epsId: string, on: boolean): void {
  for (const d of store.all()) if (d.poweredBy === epsId) noteManual(d.id, on ? "on" : "off");
}

export function saveGroups(groups: GroupConfig[]): GroupConfig[] {
  const clean: GroupConfig[] = groups.map((g) => ({
    id: String(g.id || "").trim() || `g-${randomUUID().slice(0, 8)}`,
    label: String(g.label ?? "").trim().slice(0, 60) || "Group",
    members: [...new Set((g.members ?? []).map(String))],
  }));
  const cfg = getConfig();
  saveConfig({ ...cfg, groups: clean });
  for (const k of [...targets.keys()]) if (k !== ALL_GROUP && !clean.some((g) => g.id === k)) targets.delete(k);
  publish();
  return clean;
}

export function dismissAlert(id: string | "all"): void {
  alerts = id === "all" ? [] : alerts.filter((a) => a.id !== id);
  store.setAlerts(alerts);
}

/** test-only */
export function _resetEngineForTest(): void {
  targets.clear();
  manual.clear();
  engineBlackout.clear();
  alerts = [];
  store.setAlerts([]);
  lastObservedOn.clear();
  chain = Promise.resolve();
  generation = 0;
  busy = false;
  progress = undefined;
  progressDevices = new Set();
}
/** test-only: resolves when the engine has finished everything queued so far */
export function _whenIdle(): Promise<void> {
  return chain;
}

export function startGroupEngine(): void {
  if (started) return;
  started = true;
  for (const d of store.all()) lastObservedOn.set(d.id, observe(d) === "on");
  bus.on("device:patch", (p) => {
    queueMicrotask(() => checkDrift(p.id));
    publish();
  });
  publish();
}

/* ---- drift: something came back on after we (or a schedule) switched it off ---- */

function checkDrift(id: string): void {
  const d = store.get(id);
  if (!d) return;
  const nowOn = observe(d) === "on";
  const wasOn = lastObservedOn.get(id) ?? nowOn;
  lastObservedOn.set(id, nowOn);
  if (!nowOn || wasOn || busy) return;
  const r = resolveNow().get(id);
  if (!r?.target || r.target === "on" || r.manual) return;
  // it's meant to be off/standby, but held on for someone else? then "on" is expected for power-only kinds
  const rec = r.via.includes("Everything") ? targets.get(ALL_GROUP) : [...targets.entries()].find(([gid]) =>
    groupsCfg().find((g) => g.id === gid && g.members.includes(id) && r.via.includes(g.label)))?.[1];
  const when = rec ? new Date(rec.setAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const text = `${d.label} turned On after it was set to ${LABEL[r.target]}${rec ? ` (${rec.setBy}, ${when})` : ""}.`;
  const alert: PowerAlert = { id: randomUUID(), at: Date.now(), level: "warn", text, deviceId: id };
  alerts = [alert, ...alerts].slice(0, 20);
  log.warn({ device: id, target: r.target, via: r.via }, "device turned on after being switched off");
  store.setAlerts(alerts);
}

/* ---- execution ---- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function runReconcile(groupIds: string[]): Promise<void> {
  const gen = ++generation;
  void groupIds;
  const run = chain.then(() => reconcile(gen));
  chain = run.catch((e) => log.error({ err: e }, "power engine run failed"));
  return Promise.resolve();
}

async function reconcile(gen: number): Promise<void> {
  if (gen !== generation) return; // a newer change supersedes this one; it runs next
  busy = true;
  const failures: string[] = [];
  const attempt = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`${what}: ${msg}`);
      log.warn({ what, err: e }, "power engine step failed");
    }
  };
  try {
    const cfg = getConfig();
    const devices = store.all();
    const res = resolveNow();
    const targetOf = (id: string) => res.get(id)?.target;
    const epsCfgs = cfg.devices.filter((d) => d.type === "expromo-eps" && d.enabled);

    // Per-EPS relay plan
    const plans = new Map<string, { desired: (boolean | undefined)[]; heldOn: Map<string, string[]> }>();
    for (const e of epsCfgs) {
      const members = devices.filter((d) => d.poweredBy === e.id);
      const prot = new Set((e.type === "expromo-eps" ? e.outputs ?? [] : []).filter((o) => o.protected).map((o) => o.index));
      plans.set(e.id, planEpsOutputs(members, targetOf, prot));
    }
    const onUnit = (epsId: string) => devices.filter((d) => d.poweredBy === epsId).map((d) => d.id);
    const held = new Set<string>();
    for (const p of plans.values()) for (const id of p.heldOn.keys()) held.add(id);

    // What each device needs, soft-wise
    const softOff: { d: DeviceState; mode: "standby" | "blackout" }[] = [];
    const softOn: DeviceState[] = [];
    for (const d of devices) {
      const t = targetOf(d.id);
      if (!t) continue;
      const k = kindOf(d);
      const cutByEps = !!d.poweredBy && t === "off" && !held.has(d.id);
      if (t === "on") {
        if (k === "exview" || k === "novastar") softOn.push(d);
      } else if (!cutByEps) {
        if (k === "exview") softOff.push({ d, mode: "standby" });
        else if (k === "novastar") softOff.push({ d, mode: "blackout" });
      }
    }

    // 1) soft-off
    const doSoftOff = softOff.filter(({ d }) => d.status === "online" && observe(d) !== (d.type === "exview" ? "standby" : "blackout"));
    if (doSoftOff.length) {
      setProgress(`Standby / blackout: ${doSoftOff.map((x) => x.d.label).join(", ")}`, doSoftOff.map((x) => x.d.id));
      await Promise.all(doSoftOff.map(({ d }) => attempt(d.label, () => softOffDevice(d))));
    }
    if (gen !== generation) return;

    // 2) switch-offs, units in reverse order
    for (const e of [...epsCfgs].reverse()) {
      const want = plans.get(e.id)!.desired.map((v) => (v === false ? false : undefined));
      if (!needsChange(e.id, want)) continue;
      setProgress(`Switching off ${e.label}`, onUnit(e.id));
      await attempt(e.label, () => getDriver(e.id)!.applyOutputs!(want));
    }
    if (gen !== generation) return;

    // 3) switch-ons, one unit at a time, gap between units (one inrush at a time)
    let first = true;
    for (const e of epsCfgs) {
      const want = plans.get(e.id)!.desired.map((v) => (v === true ? true : undefined));
      if (!needsChange(e.id, want)) continue;
      if (!first) await sleep(_engineTiming.unitGapMs);
      first = false;
      setProgress(`Powering on ${e.label}`, onUnit(e.id));
      await attempt(e.label, () => getDriver(e.id)!.applyOutputs!(want));
      if (gen !== generation) return;
    }

    // 4) soft-on: wait for each device to be reachable, then wake / show — staggered
    let wakeIndex = 0;
    const waits = softOn.map(async (d) => {
      const ready = await waitOnline(d.id, gen);
      if (!ready || gen !== generation) return;
      const cur = store.get(d.id)!;
      if (d.type === "exview") {
        if (observe(cur) === "on") return;
        const slot = wakeIndex++;
        if (slot > 0) await sleep(slot * _engineTiming.wakeStaggerMs);
        if (gen !== generation) return;
        await attempt(d.label, () => wake(cur));
      } else if (engineBlackout.has(d.id)) {
        await attempt(d.label, () => unblackout(cur));
      }
    });
    if (softOn.length) {
      const pending = softOn.filter((d) => store.get(d.id)?.status !== "online");
      setProgress(
        pending.length ? `Waiting for ${pending.map((d) => d.label).join(", ")}` : "Waking screens",
        (pending.length ? pending : softOn).map((d) => d.id),
      );
      await Promise.all(waits);
    }
  } finally {
    if (gen === generation) {
      busy = false;
      progressDevices = new Set();
      progress = undefined;
      for (const d of store.all()) lastObservedOn.set(d.id, observe(d) === "on");
      publish();
      if (failures.length) toast("warn", `Power: ${failures.length} step(s) failed — ${failures.join("; ")}`);
    }
  }
}

function needsChange(epsId: string, want: (boolean | undefined)[]): boolean {
  const bits = store.get(epsId)?.extra?.outputs as string | undefined;
  if (!bits) return want.some((v) => v !== undefined); // unknown — let the driver check
  return want.some((v, i) => v !== undefined && (bits[i] === "1") !== v);
}

async function waitOnline(id: string, gen: number): Promise<boolean> {
  const deadline = Date.now() + _engineTiming.bootWaitMs;
  while (Date.now() < deadline) {
    if (gen !== generation) return false;
    if (store.get(id)?.status === "online") return true;
    await sleep(_engineTiming.pollMs);
  }
  return false;
}

async function softOffDevice(d: DeviceState): Promise<void> {
  const drv = getDriver(d.id);
  if (!drv) return;
  if (d.type === "exview") {
    await drv.setPowerState!(d.zones[0]?.id ?? "screen", "standby");
    return;
  }
  for (const z of d.zones) if (!z.blackout) await drv.setBlackout!(z.id, true);
  engineBlackout.add(d.id);
}

async function wake(d: DeviceState): Promise<void> {
  await getDriver(d.id)!.setPowerState!(d.zones[0]?.id ?? "screen", "on");
}

async function unblackout(d: DeviceState): Promise<void> {
  const drv = getDriver(d.id)!;
  for (const z of d.zones) if (z.blackout) await drv.setBlackout!(z.id, false);
  engineBlackout.delete(d.id);
}
