import { randomUUID } from "node:crypto";
import type { Schedule, ScheduleEntry, ScheduleAction } from "@excontrol/shared";
import { nextEntry, SHUTDOWN_ACTIONS, ALL_GROUP, roomLabel } from "@excontrol/shared";
import { getConfig, saveConfig } from "../config.js";
import { bus, toast } from "./bus.js";
import { powerDomain } from "./power.js";
import { setGroupTarget } from "./groups.js";
import { applyPreset } from "./presets.js";
import { log } from "../logger.js";

const HOUR = 3_600_000;
const MAX_EXTENSION_HOURS = 12;

export function getSchedule(): Schedule {
  return getConfig().schedule;
}

function persist(schedule: Schedule): Schedule {
  const cfg = getConfig();
  saveConfig({ ...cfg, schedule });
  bus.emit("broadcast", { t: "schedule", schedule });
  return schedule;
}

export function setEntries(entries: ScheduleEntry[]): Schedule {
  const clean: ScheduleEntry[] = entries.map((e) => ({
    id: e.id || randomUUID(),
    label: String(e.label ?? "").slice(0, 60) || "Schedule",
    time: /^\d{2}:\d{2}$/.test(e.time) ? e.time : "17:00",
    days: Array.isArray(e.days) ? e.days.filter((d) => d >= 0 && d <= 6) : [],
    action: (["power_on", "power_off", "standby", "apply_preset"] as ScheduleAction[]).includes(e.action) ? e.action : "power_off",
    target: e.target || (e.action === "apply_preset" ? undefined : "all"),
    presetId: e.action === "apply_preset" ? e.presetId : undefined,
    outputs: Array.isArray(e.outputs) ? e.outputs : undefined,
    enabled: Boolean(e.enabled),
  }));
  return persist({ ...getSchedule(), entries: clean });
}

export function snooze(add: number, clear = false): Schedule {
  const now = Date.now();
  const cur = getSchedule();
  const active = (cur.snoozeUntil ?? 0) > now;

  if (clear || add <= 0) {
    if (active) toast("info", "Shutdown extension cancelled");
    return persist({ ...cur, snoozeUntil: 0, snoozeHours: 0, snoozeEntryId: undefined });
  }

  // Extend *one* shutdown — the next one. Only that entry is held back, and only its own
  // target fires when the extension runs out (before 0.3 it fired "all", whatever it was).
  const next = nextEntry(cur, SHUTDOWN_ACTIONS, new Date(now));
  const raw = next?.at ?? null;
  if (!active && raw === null) {
    toast("warn", "No shutdown scheduled to extend");
    return cur;
  }
  const prevHours = active ? (cur.snoozeHours ?? 0) : 0;
  const hours = Math.min(prevHours + add, MAX_EXTENSION_HOURS);
  if (hours === prevHours) {
    toast("warn", `Maximum extension is ${MAX_EXTENSION_HOURS}h`);
    return cur;
  }
  const base = active ? (cur.snoozeUntil ?? now) : (raw as number);
  const snoozeUntil = base + (hours - prevHours) * HOUR;
  const entryId = active ? cur.snoozeEntryId : next?.entry.id;
  const entry = cur.entries.find((e) => e.id === entryId);
  toast("info", `${entry ? targetLabel(entry.target) + " shutdown" : "Shutdown"} moved to ${fmt(snoozeUntil)} (+${hours}h)`);
  return persist({ ...cur, snoozeUntil, snoozeHours: hours, snoozeEntryId: entryId });
}

/** "Everything", a group's label, or an EPS's label — for messages. */
export function targetLabel(target: string | undefined): string {
  const t = target || "all";
  if (t === ALL_GROUP) return roomLabel(getConfig().app.name);
  if (t.startsWith("group:")) return getConfig().groups.find((g) => g.id === t.slice(6))?.label ?? t.slice(6);
  return getConfig().devices.find((d) => d.id === t)?.label ?? t;
}

async function fire(e: Pick<ScheduleEntry, "action" | "label" | "target" | "presetId">): Promise<void> {
  log.info({ label: e.label, action: e.action, target: e.target }, "schedule firing");
  const setBy = `Schedule: ${e.label}`;
  try {
    if (e.action === "apply_preset") {
      if (e.presetId) await applyPreset(e.presetId);
    } else {
      const state = e.action === "power_on" ? "on" : e.action === "standby" ? "standby" : "off";
      const t = e.target || "all";
      if (t === ALL_GROUP) await setGroupTarget(ALL_GROUP, state, setBy);
      else if (t.startsWith("group:")) await setGroupTarget(t.slice(6), state, setBy);
      else if (state === "standby") log.warn({ target: t }, "standby on a single EPS isn't a thing — skipped");
      else await powerDomain(t, state === "on", setBy);
    }
  } catch (err) {
    log.error({ err }, "schedule action failed");
    toast("error", `${e.label}: ${err instanceof Error ? err.message : String(err)}`);
  }
  persist({ ...getSchedule(), lastRun: { id: e.label, at: Date.now(), action: e.action } });
}

function fmt(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** ~1-minute ticker (checks every 20 s). */
export function startScheduler(): () => void {
  let lastTickMinute = "";
  const tick = () => {
    const now = new Date();
    const nowMs = now.getTime();
    const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

    const sn = getSchedule().snoozeUntil ?? 0;
    if (sn > 0 && nowMs >= sn) {
      // fire the extended entry itself — its own target and action, nothing wider
      const cur = getSchedule();
      const ext = cur.entries.find((x) => x.id === cur.snoozeEntryId);
      persist({ ...cur, snoozeUntil: 0, snoozeHours: 0, snoozeEntryId: undefined });
      void fire(ext
        ? { ...ext, label: `${ext.label} (extended)` }
        : { action: "power_off", label: "Extended shutdown", target: "all" }); // pre-0.3 extension with no entry id
    }

    if (hhmm === lastTickMinute) return;
    lastTickMinute = hhmm;
    const dow = now.getDay();
    const snoozed = (getSchedule().snoozeUntil ?? 0) > nowMs;
    const snoozedEntry = getSchedule().snoozeEntryId;

    for (const e of getSchedule().entries) {
      if (!e.enabled || e.time !== hhmm) continue;
      if (e.days.length && !e.days.includes(dow)) continue;
      // Only the extended entry is held back (a pre-0.3 extension without an entry id holds
      // back every shutdown, as it always did).
      if (snoozed && SHUTDOWN_ACTIONS.includes(e.action) && (!snoozedEntry || snoozedEntry === e.id)) {
        log.info({ entry: e.label }, "scheduled shutdown postponed by user");
        continue;
      }
      void fire(e);
    }
  };
  tick();
  const timer = setInterval(tick, 20_000);
  return () => clearInterval(timer);
}
