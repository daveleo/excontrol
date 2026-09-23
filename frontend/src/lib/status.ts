import type { AppState, DeviceState, PowerDomain } from "@excontrol/shared";
import { roomLabel, ALL_GROUP } from "@excontrol/shared";

/**
 * One vocabulary for state, used by every card, row and bar — so "off" always looks and
 * reads the same. Tone drives colour: on = green, off = grey, warn = amber (standby,
 * starting, changing), fault = red. Red means someone needs to look; nothing else is red.
 */
export type Tone = "on" | "off" | "warn" | "fault";
export interface Status { word: string; tone: Tone; hint?: string; detail?: string }

export const isDisplay = (d: DeviceState) =>
  d.type === "novastar-h" || d.type === "novastar-coex" || d.type === "exview";

export function deviceStatus(d: DeviceState): Status {
  if (d.status === "powered-off") return { word: "No power", tone: "off" };
  if (d.status === "initializing" || d.status === "connecting") {
    const note = d.type === "exview" && d.error ? d.error : "";
    if (/waking/i.test(note)) return { word: "Waking…", tone: "warn", hint: "Waking from standby takes 30–70 s." };
    if (/standby/i.test(note)) return { word: "Going to standby…", tone: "warn" };
    return { word: "Starting…", tone: "warn" };
  }
  if (d.status !== "online") {
    return { word: "Not responding", tone: "fault", hint: "Check its power and network.", detail: d.error };
  }
  if (d.type === "exview") {
    const ps = d.zones[0]?.powerState;
    if (ps === "standby") return { word: "Standby", tone: "warn" };
    if (ps === "blackout") return { word: "Black", tone: "warn" };
    return { word: "On", tone: "on" };
  }
  if ((d.type === "novastar-h" || d.type === "novastar-coex") && d.zones.length && d.zones.every((z) => z.blackout)) {
    return { word: "Black", tone: "warn" };
  }
  return { word: "On", tone: "on" };
}

/** "Last: 36% · MAIN_NIX_PILLE" — what a device will come back with. */
export function lastKnown(d: DeviceState): string {
  const z = d.zones[0];
  if (!z) return "";
  const parts: string[] = [];
  if (typeof z.brightness === "number") parts.push(`${z.brightness}%`);
  const p = z.presets?.find((x) => x.id === z.activePreset);
  if (p) parts.push(p.name);
  return parts.length ? `Last: ${parts.join(" · ")}` : "";
}

export function epsStatus(eps: DeviceState, domain?: PowerDomain): Status {
  if (eps.status !== "online") return { word: "Not responding", tone: "fault", hint: "Check the unit and its network." };
  const bits = String(eps.extra?.outputs ?? "");
  const state = String(eps.extra?.state ?? "");
  if (state === "SEQUENCING" || domain?.level === "starting") return { word: "Starting…", tone: "warn", detail: domain?.detail };
  if (!bits.includes("1")) return { word: "Off", tone: "off" };
  if (bits === "111111") return { word: "On", tone: "on" };
  return { word: "Partly on", tone: "on" };
}

/** Who hangs off output `i` (1-6) of this EPS. */
export function outputOwner(eps: DeviceState, devices: DeviceState[], i: number): string {
  const members = devices.filter((d) => d.poweredBy === eps.id);
  const claimed = members.find((d) => d.poweredByOutput === i);
  if (claimed) return claimed.label;
  const whole = members.filter((d) => !d.poweredByOutput).map((d) => d.label);
  return whole.join(", ");
}

/** The whole room, in one word — for the power bar. */
export function roomStatus(state: AppState): Status & { name: string } {
  const name = roomLabel(state.app.name);
  const all = state.groups?.find((g) => g.id === ALL_GROUP);
  if (all?.busy) {
    const w = all.target === "on" ? "Turning on…" : all.target === "standby" ? "Going to standby…" : "Turning off…";
    return { name, word: w, tone: "warn", detail: all.progress };
  }
  const starting = state.powerDomains.find((p) => p.level === "starting");
  if (starting) return { name, word: "Starting…", tone: "warn", detail: starting.detail };

  const members = state.devices.filter(isDisplay);
  const st = members.map(deviceStatus);
  const on = st.filter((s) => s.tone === "on").length;
  const warn = st.filter((s) => s.tone === "warn").length;
  const off = st.filter((s) => s.tone === "off").length;
  if (!members.length) {
    const epsOn = state.devices.some((d) => d.type === "expromo-eps" && String(d.extra?.outputs ?? "").includes("1"));
    return { name, word: epsOn ? "On" : "Off", tone: epsOn ? "on" : "off" };
  }
  if (on && !warn && !off) return { name, word: "On", tone: "on" };
  if (on) return { name, word: "Partly on", tone: "on" };
  if (warn && !off) return { name, word: "Standby", tone: "warn" };
  return { name, word: "Off", tone: "off" };
}

/** Things that need a person — the only red on the dashboard. */
export function faults(state: AppState): string[] {
  const out: string[] = [];
  for (const d of state.devices) {
    if (d.status === "offline" || d.status === "error") out.push(d.label);
  }
  return out;
}

/** "at 17:00" today, "tomorrow at 17:00", "Mon at 17:00" */
export function whenPhrase(d: Date, now: Date = new Date()): string {
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86_400_000);
  const t = hhmm(d);
  if (diff === 0) return `at ${t}`;
  if (diff === 1) return `tomorrow at ${t}`;
  return `${d.toLocaleDateString([], { weekday: "short" })} at ${t}`;
}

export const hhmm = (ts: number | Date) =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
