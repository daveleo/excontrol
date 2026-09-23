/**
 * Pure schedule math — shared by the backend ticker and the front-end countdown so they
 * can never drift. Local time throughout.
 */
import type { Schedule, ScheduleAction, ScheduleEntry } from "./index.js";

/** Entries that take the room down — both get the 15-min warning and can be extended. */
export const SHUTDOWN_ACTIONS: ScheduleAction[] = ["power_off", "standby"];

/** Next moment (epoch ms) an enabled entry with this action fires, at or after `from`. */
export function nextOccurrence(
  schedule: Pick<Schedule, "entries">,
  action: ScheduleAction | ScheduleAction[],
  from: Date = new Date(),
): number | null {
  return nextEntry(schedule, action, from)?.at ?? null;
}

/** Like nextOccurrence, but also says which entry it is. */
export function nextEntry(
  schedule: Pick<Schedule, "entries">,
  action: ScheduleAction | ScheduleAction[],
  from: Date = new Date(),
  skipEntryId?: string,
): { at: number; entry: ScheduleEntry } | null {
  const actions = Array.isArray(action) ? action : [action];
  let best: { at: number; entry: ScheduleEntry } | null = null;
  for (const e of schedule.entries) {
    if (!e.enabled || !actions.includes(e.action) || e.id === skipEntryId) continue;
    const m = /^(\d{1,2}):(\d{2})$/.exec(e.time);
    if (!m) continue;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    for (let d = 0; d < 8; d++) {
      const cand = new Date(from);
      cand.setDate(cand.getDate() + d);
      cand.setHours(hh, mm, 0, 0);
      if (cand.getTime() <= from.getTime()) continue;
      if (e.days.length && !e.days.includes(cand.getDay())) continue;
      if (best === null || cand.getTime() < best.at) best = { at: cand.getTime(), entry: e };
      break;
    }
  }
  return best;
}

/**
 * The shutdown that will actually happen next, honouring an active extension.
 * `extendedHours` > 0 means the user has pushed it back.
 */
export function effectiveShutdown(
  schedule: Schedule,
  now: Date = new Date(),
): { at: Date; extendedHours: number; entry?: ScheduleEntry } | null {
  const snoozeUntil = schedule.snoozeUntil ?? 0;
  const snoozed = snoozeUntil > now.getTime();
  // The extended entry is held back until snoozeUntil; any *other* shutdown that comes
  // sooner is still the next thing that will actually happen.
  const other = nextEntry(schedule, SHUTDOWN_ACTIONS, now, snoozed ? schedule.snoozeEntryId : undefined);
  if (snoozed && (!other || other.at >= snoozeUntil || !schedule.snoozeEntryId)) {
    const entry = schedule.entries.find((e) => e.id === schedule.snoozeEntryId);
    return { at: new Date(snoozeUntil), extendedHours: schedule.snoozeHours ?? 0, entry };
  }
  return other ? { at: new Date(other.at), extendedHours: 0, entry: other.entry } : null;
}

export function nextPowerOn(schedule: Schedule, now: Date = new Date()): Date | null {
  const r = nextOccurrence(schedule, "power_on", now);
  return r ? new Date(r) : null;
}

/** "2h 14m" / "12m" */
export function humanDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** "17:00" / "Tomorrow 08:00" / "Mon 08:00" */
export function humanWhen(d: Date, now: Date = new Date()): string {
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const startOfDay = (x: Date) => {
    const c = new Date(x);
    c.setHours(0, 0, 0, 0);
    return c.getTime();
  };
  const days = Math.round((startOfDay(d) - startOfDay(now)) / 86_400_000);
  if (days === 0) return time;
  if (days === 1) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/** "m:ss" for the big countdown */
export function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
