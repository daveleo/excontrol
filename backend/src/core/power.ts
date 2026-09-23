import type { DeviceState, PowerDomain, PowerLevel } from "@excontrol/shared";
import { ALWAYS_ON_DOMAIN, ALL_GROUP } from "@excontrol/shared";
import { bus } from "./bus.js";
import { store } from "./state.js";
import { getConfig } from "../config.js";
import { getDriver } from "./registry.js";
import { getPresets, applyPreset } from "./presets.js";
import { log } from "../logger.js";

/** How long to wait for a controller to come online after power-on before proceeding without it. */
const BOOT_GRACE_MS = 4 * 60_000;

export interface DomainRuntime {
  /** ms we first saw this EPS reporting ON in this process (reset to 0 whenever it reports OFF). */
  epsFirstOn: number;
  prevLevel: PowerLevel;
  /** true once we've witnessed this domain OFF — gates power-on-preset firing so a plain
   *  eXcontrol restart next to an already-on wall doesn't yank settings back to the default. */
  applyArmed: boolean;
}
const rt = new Map<string, DomainRuntime>();
function runtime(id: string): DomainRuntime {
  let r = rt.get(id);
  if (!r) {
    r = { epsFirstOn: 0, prevLevel: "unknown", applyArmed: false };
    rt.set(id, r);
  }
  return r;
}

/** test-only: wipe the per-domain runtime so a fresh scenario starts clean */
export function _resetRuntimeForTest(): void {
  rt.clear();
}

function domainMembers(devices: DeviceState[], epsId: string): DeviceState[] {
  return devices.filter((d) => d.poweredBy === epsId && d.id !== epsId);
}

type PowerMember = Pick<DeviceState, "id" | "poweredByOutput">;

/**
 * Which relays each member of one EPS depends on. A member with poweredByOutput owns that
 * one output; every other member shares "the rest" — all outputs nobody claimed. So the
 * showroom's H9 + COEX (whole unit) and the eXview (output 3) can coexist on one box, and
 * switching the eXview's output never touches the wall's.
 */
export function outputOwnership(members: PowerMember[]): {
  claimed: Map<number, string>;
  whole: string[];
  rest: number[];
} {
  const claimed = new Map<number, string>();
  const whole: string[] = [];
  for (const m of members) {
    if (m.poweredByOutput != null && m.poweredByOutput >= 1 && m.poweredByOutput <= 6) claimed.set(m.poweredByOutput, m.id);
    else whole.push(m.id);
  }
  const rest = [1, 2, 3, 4, 5, 6].filter((i) => !claimed.has(i));
  return { claimed, whole, rest };
}

/** The outputs one member depends on (1-based). */
export function outputsOf(member: PowerMember, members: PowerMember[]): number[] {
  if (member.poweredByOutput != null) return [member.poweredByOutput];
  return outputOwnership(members).rest;
}

/** Is this member's own supply off, given the EPS's reported state? Pure — for tests. */
export function memberSupplyOff(eps: DeviceState, member: PowerMember, members: PowerMember[]): boolean {
  if (eps.status !== "online") return false; // unknown, not "off"
  const sys = eps.extra?.system as string | undefined;
  const state = eps.extra?.state as string | undefined;
  if (state === "SEQUENCING") return false; // coming up
  if (sys === "OFF") return true;
  const bits = eps.extra?.outputs as string | undefined;
  if (!bits || bits.length < 6) return false;
  return outputsOf(member, members).every((i) => bits[i - 1] === "0");
}

export function computeEpsDomain(eps: DeviceState, members: DeviceState[], r: DomainRuntime): PowerDomain {
  const reachable = eps.status === "online";
  const sys = eps.extra?.system as string | undefined;
  const state = eps.extra?.state as string | undefined;
  const outputs = eps.extra?.outputs as string | undefined;
  const outputsOff: number[] = [];
  if (sys === "ON" && outputs) [...outputs].forEach((c, i) => c === "0" && outputsOff.push(i + 1));

  const epsWrap = { system: sys, state, outputs, outputsOff, reachable };
  // A member whose own output is switched off isn't expected online — don't wait for it,
  // and don't call it "not responding".
  const powered = members.filter((d) => !memberSupplyOff(eps, d, members));
  const membersOnline = powered.every((d) => d.status === "online");
  // Give the controllers time to boot both after a power cycle AND when eXcontrol itself
  // starts up next to an already-on wall (control PC + wall powered on together).
  const grace = r.epsFirstOn > 0 && Date.now() - r.epsFirstOn < BOOT_GRACE_MS;

  let level: PowerLevel;
  let headline: string;
  let detail: string | undefined;

  if (!reachable) {
    level = "unknown";
    headline = `${eps.label}: power controller not responding`;
    detail = `Cannot reach the EPS at ${epsHost(eps.id)}. Check the network / the unit.`;
  } else if (sys === "OFF") {
    level = "off";
    headline = `${eps.label}: OFF`;
    detail = members.length ? "The equipment on this power unit is off. Press Power On to start it." : undefined;
  } else if (state === "SEQUENCING" || sys !== "ON") {
    level = "starting";
    headline = `${eps.label}: starting up…`;
    detail = "Power is sequencing on.";
  } else if (!membersOnline && grace) {
    const waiting = powered.filter((d) => d.status !== "online").map((d) => d.label).join(" and ");
    level = "starting";
    headline = `${eps.label}: starting up…`;
    detail = `Power is on — waiting for ${waiting || "the controllers"} to finish initializing.`;
  } else {
    level = "on";
    headline = `${eps.label}: ON`;
    detail = outputsOff.length
      ? `Warning: output ${outputsOff.join(", ")} is OFF`
      : !membersOnline
        ? "Some equipment on this power unit is not responding."
        : undefined;
  }

  return {
    id: eps.id,
    label: eps.label,
    level,
    headline,
    detail,
    partial: level === "on" && outputsOff.length > 0 && membersOnline,
    members: [eps.id, ...members.map((d) => d.id)],
    eps: epsWrap,
  };
}

function epsHost(id: string): string {
  return getConfig().devices.find((d) => d.id === id)?.host ?? "the EPS";
}

function recompute(): void {
  const devices = store.all();
  const epsDevices = devices.filter((d) => d.type === "expromo-eps");
  const domains: PowerDomain[] = [];
  const devicePower = new Map<string, PowerLevel>();

  for (const eps of epsDevices) {
    const r = runtime(eps.id);
    const sysNow = eps.extra?.system as string | undefined;
    if (sysNow === "ON" && r.epsFirstOn === 0) r.epsFirstOn = Date.now();
    if (sysNow === "OFF") r.epsFirstOn = 0; // next "on" starts a fresh boot-grace window

    const members = domainMembers(devices, eps.id);
    const dom = computeEpsDomain(eps, members, r);
    domains.push(dom);
    for (const m of members) devicePower.set(m.id, memberSupplyOff(eps, m, members) ? "off" : dom.level);

    if (dom.level === "off") r.applyArmed = true;
    if (shouldFirePowerOn(r, dom.level, r.prevLevel)) {
      r.applyArmed = false;
      void applyPowerOnDefaults(eps.id, dom.members).catch((e) => log.error({ err: e }, "power-on preset failed"));
    }
    r.prevLevel = dom.level;
  }

  // the "always on" group — devices with no poweredBy
  const unpowered = devices.filter((d) => !d.poweredBy && d.type !== "expromo-eps");
  if (unpowered.length) {
    domains.push({
      id: ALWAYS_ON_DOMAIN,
      label: "Always on",
      level: "on",
      headline: "",
      members: unpowered.map((d) => d.id),
    });
  }

  store.setDevicePower(devicePower);
  const changed = store.setDomains(domains);
  if (changed.length) bus.emit("broadcast", { t: "power", domains: store.domainsList() });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fire this domain's power-on presets on this recompute? Pure — extracted for tests. */
export function shouldFirePowerOn(
  r: Pick<DomainRuntime, "applyArmed">,
  level: PowerLevel,
  prevLevel: PowerLevel,
): boolean {
  return r.applyArmed && level === "on" && (prevLevel === "off" || prevLevel === "starting");
}

/** settle timings — overridable in tests so the power-on sequence doesn't take 13s */
export const _powerOnTiming = { settleMs: 4000, reapplyMs: 9000 };

async function applyPowerOnDefaults(epsId: string, memberIds: string[]): Promise<void> {
  const only = new Set(memberIds);
  const presets = getPresets().filter((p) => p.powerOnDefaultFor === epsId || p.powerOnDefaultFor === "all");
  if (!presets.length) return;
  log.info({ epsId, presets: presets.map((p) => p.label) }, "applying power-on defaults");

  // Controllers keep finalising their own boot state for a few seconds after their API
  // responds and can overwrite a value set right then — so settle, apply, then apply once more.
  await sleep(_powerOnTiming.settleMs);
  for (const p of presets) await applyPreset(p.id, { only });
  await sleep(_powerOnTiming.reapplyMs);
  for (const p of presets) await applyPreset(p.id, { only, silent: true });
}

export function startPowerMonitor(): void {
  bus.on("device:patch", () => queueMicrotask(recompute));
  recompute();
}

/** Force a power-domain recompute — used after a config reload changes the device set. */
export function recomputePower(): void {
  recompute();
}

/** Whole-unit power for one EPS (the EPS card, Companion, a schedule entry targeting an EPS).
 *  The driver makes it safe: switching on a partly-on unit only adds the missing outputs,
 *  protected outputs are never switched off, and the result is verified. "all" goes through
 *  the power engine instead (Everything, chained, screens included). */
export async function powerDomain(target: string, on: boolean, setBy = "Manual"): Promise<void> {
  if (target === "all") {
    const { setGroupTarget } = await import("./groups.js");
    await setGroupTarget(ALL_GROUP, on ? "on" : "off", setBy);
    return;
  }
  const drv = getDriver(target);
  if (!drv?.action || drv.type !== "expromo-eps") throw new Error(`"${target}" is not a controllable EPS`);
  const { noteEpsManual } = await import("./groups.js");
  noteEpsManual(target, on);
  await drv.action(on ? "power_on" : "power_off");
}
