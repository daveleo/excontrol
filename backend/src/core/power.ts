import type { DeviceState, PowerDomain, PowerLevel } from "@excontrol/shared";
import { ALWAYS_ON_DOMAIN } from "@excontrol/shared";
import { bus } from "./bus.js";
import { store } from "./state.js";
import { getConfig } from "../config.js";
import { getDriver } from "./registry.js";
import { getPresets, applyPreset } from "./presets.js";
import { log } from "../logger.js";

/** How long to wait for a controller to come online after power-on before proceeding without it. */
const BOOT_GRACE_MS = 4 * 60_000;

interface DomainRuntime {
  epsOnSince: number; // ms the EPS was seen ON *after* being seen OFF (0 = not a fresh power-on)
  sawOff: boolean;
  prevLevel: PowerLevel;
  applyArmed: boolean;
}
const rt = new Map<string, DomainRuntime>();
function runtime(id: string): DomainRuntime {
  let r = rt.get(id);
  if (!r) {
    r = { epsOnSince: 0, sawOff: false, prevLevel: "unknown", applyArmed: false };
    rt.set(id, r);
  }
  return r;
}

function domainMembers(devices: DeviceState[], epsId: string): DeviceState[] {
  return devices.filter((d) => d.poweredBy === epsId && d.id !== epsId);
}

function computeEpsDomain(eps: DeviceState, members: DeviceState[], r: DomainRuntime): PowerDomain {
  const reachable = eps.status === "online";
  const sys = eps.extra?.system as string | undefined;
  const state = eps.extra?.state as string | undefined;
  const outputs = eps.extra?.outputs as string | undefined;
  const outputsOff: number[] = [];
  if (sys === "ON" && outputs) [...outputs].forEach((c, i) => c === "0" && outputsOff.push(i + 1));

  const epsWrap = { system: sys, state, outputs, outputsOff, reachable };
  const membersOnline = members.length === 0 || members.every((d) => d.status === "online");
  const grace = r.epsOnSince > 0 && Date.now() - r.epsOnSince < BOOT_GRACE_MS;

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
    const waiting = members.filter((d) => d.status !== "online").map((d) => d.label).join(" and ");
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

  for (const eps of epsDevices) {
    const r = runtime(eps.id);
    const sysNow = eps.extra?.system as string | undefined;
    if (sysNow === "OFF") {
      r.sawOff = true;
      r.epsOnSince = 0;
    } else if (sysNow === "ON" && r.sawOff && r.epsOnSince === 0) {
      r.epsOnSince = Date.now();
    }

    const members = domainMembers(devices, eps.id);
    const dom = computeEpsDomain(eps, members, r);
    domains.push(dom);

    if (dom.level === "off" || dom.level === "starting") r.applyArmed = true;
    if (r.applyArmed && dom.level === "on" && (r.prevLevel === "off" || r.prevLevel === "starting")) {
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

  const changed = store.setDomains(domains);
  if (changed.length) bus.emit("broadcast", { t: "power", domains: store.domainsList() });
}

async function applyPowerOnDefaults(epsId: string, memberIds: string[]): Promise<void> {
  const only = new Set(memberIds);
  const presets = getPresets().filter((p) => p.powerOnDefaultFor === epsId || p.powerOnDefaultFor === "all");
  for (const p of presets) await applyPreset(p.id, { only });
}

export function startPowerMonitor(): void {
  bus.on("device:patch", () => queueMicrotask(recompute));
  recompute();
}

/** Fire an EPS power command by domain (eps id) or "all". */
export async function powerDomain(target: string, on: boolean): Promise<void> {
  const cfg = getConfig();
  const epsIds =
    target === "all"
      ? cfg.devices.filter((d) => d.type === "expromo-eps").map((d) => d.id)
      : [target];
  const cmd = on ? "power_on" : "power_off";
  await Promise.all(
    epsIds.map((id) => {
      const drv = getDriver(id);
      if (!drv?.action) throw new Error(`"${id}" is not a controllable EPS`);
      return drv.action(cmd);
    }),
  );
}
