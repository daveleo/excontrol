import { randomUUID } from "node:crypto";
import type { Schedule, ScheduleEntry, ScheduleAction } from "@excontrol/shared";
import { nextOccurrence } from "@excontrol/shared";
import { getConfig, saveConfig } from "../config.js";
import { bus, toast } from "./bus.js";
import { powerDomain } from "./power.js";
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
    action: (["power_on", "power_off", "apply_preset"] as ScheduleAction[]).includes(e.action) ? e.action : "power_off",
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
    return persist({ ...cur, snoozeUntil: 0, snoozeHours: 0 });
  }

  const raw = nextOccurrence(cur, "power_off", new Date(now));
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
  toast("info", `Shutdown moved to ${fmt(snoozeUntil)} (+${hours}h)`);
  return persist({ ...cur, snoozeUntil, snoozeHours: hours });
}

async function fire(e: Pick<ScheduleEntry, "action" | "label" | "target" | "presetId">): Promise<void> {
  log.info({ label: e.label, action: e.action }, "schedule firing");
  try {
    if (e.action === "apply_preset") {
      if (e.presetId) await applyPreset(e.presetId);
    } else {
      await powerDomain(e.target || "all", e.action === "power_on");
    }
  } catch (err) {
    log.error({ err }, "schedule action failed");
  }
  persist({ ...getSchedule(), lastRun: { id: e.label, at: Date.now(), action: e.action } });
  if (e.action !== "apply_preset") {
    toast("info", `${e.label}: ${e.action === "power_off" ? "powering down" : "powering on"}`);
  }
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
      void fire({ action: "power_off", label: "Extended shutdown", target: "all" });
      persist({ ...getSchedule(), snoozeUntil: 0, snoozeHours: 0 });
    }

    if (hhmm === lastTickMinute) return;
    lastTickMinute = hhmm;
    const dow = now.getDay();
    const snoozed = (getSchedule().snoozeUntil ?? 0) > nowMs;

    for (const e of getSchedule().entries) {
      if (!e.enabled || e.time !== hhmm) continue;
      if (e.days.length && !e.days.includes(dow)) continue;
      if (e.action === "power_off" && snoozed) {
        log.info({ entry: e.label }, "scheduled power-off postponed by user");
        continue;
      }
      void fire(e);
    }
  };
  tick();
  const timer = setInterval(tick, 20_000);
  return () => clearInterval(timer);
}
