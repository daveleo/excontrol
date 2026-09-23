import { describe, it, expect } from "vitest";
import { nextOccurrence, effectiveShutdown, nextPowerOn, humanDuration, mmss, nextEntry } from "@excontrol/shared";
import type { Schedule, ScheduleEntry } from "@excontrol/shared";

const entry = (p: Partial<ScheduleEntry>): ScheduleEntry => ({
  id: p.id ?? "e", label: p.label ?? "x", time: p.time ?? "17:00", days: p.days ?? [],
  action: p.action ?? "power_off", target: p.target ?? "all", presetId: p.presetId,
  outputs: p.outputs, enabled: p.enabled ?? true,
});
const sched = (entries: ScheduleEntry[], extra: Partial<Schedule> = {}): Schedule => ({ entries, ...extra });

// A fixed Wednesday 12:00 local.
const WED_NOON = new Date(2026, 0, 7, 12, 0, 0);

describe("nextOccurrence", () => {
  it("same-day later time", () => {
    const at = nextOccurrence(sched([entry({ time: "17:00" })]), "power_off", WED_NOON);
    expect(new Date(at!).getHours()).toBe(17);
    expect(new Date(at!).getDate()).toBe(7);
  });

  it("rolls to tomorrow when the time has passed", () => {
    const at = nextOccurrence(sched([entry({ time: "08:00" })]), "power_off", WED_NOON);
    expect(new Date(at!).getDate()).toBe(8);
  });

  it("honours the day-of-week filter (Mon/Fri only)", () => {
    // Wed noon → next Friday (day 5)
    const at = nextOccurrence(sched([entry({ time: "09:00", days: [1, 5] })]), "power_off", WED_NOON);
    expect(new Date(at!).getDay()).toBe(5);
  });

  it("ignores disabled entries and other actions", () => {
    const s = sched([
      entry({ id: "a", time: "13:00", enabled: false }),
      entry({ id: "b", time: "14:00", action: "power_on" }),
    ]);
    expect(nextOccurrence(s, "power_off", WED_NOON)).toBeNull();
  });

  it("returns the earliest of several matching entries", () => {
    const s = sched([entry({ id: "a", time: "20:00" }), entry({ id: "b", time: "15:30" })]);
    const at = nextOccurrence(s, "power_off", WED_NOON);
    expect(new Date(at!).getHours()).toBe(15);
    expect(new Date(at!).getMinutes()).toBe(30);
  });
});

describe("effectiveShutdown", () => {
  it("prefers an active snooze over the schedule", () => {
    const future = WED_NOON.getTime() + 3 * 3600_000;
    const r = effectiveShutdown(sched([entry({ time: "17:00" })], { snoozeUntil: future, snoozeHours: 2 }), WED_NOON);
    expect(r!.at.getTime()).toBe(future);
    expect(r!.extendedHours).toBe(2);
  });

  it("falls back to the schedule when the snooze has lapsed", () => {
    const past = WED_NOON.getTime() - 3600_000;
    const r = effectiveShutdown(sched([entry({ time: "17:00" })], { snoozeUntil: past }), WED_NOON);
    expect(r!.at.getHours()).toBe(17);
    expect(r!.extendedHours).toBe(0);
  });

  it("is null with nothing scheduled", () => {
    expect(effectiveShutdown(sched([]), WED_NOON)).toBeNull();
  });
});

describe("nextPowerOn / formatting", () => {
  it("nextPowerOn only sees power_on entries", () => {
    const s = sched([entry({ action: "power_on", time: "07:30" }), entry({ action: "power_off", time: "06:00" })]);
    expect(nextPowerOn(s, WED_NOON)!.getHours()).toBe(7);
  });
  it("humanDuration", () => {
    expect(humanDuration(0)).toBe("0m");
    expect(humanDuration(12 * 60_000)).toBe("12m");
    expect(humanDuration((2 * 60 + 14) * 60_000)).toBe("2h 14m");
  });
  it("mmss clamps and pads", () => {
    expect(mmss(-5)).toBe("0:00");
    expect(mmss(65_000)).toBe("1:05");
  });
});

describe("shutdowns target something specific (0.3)", () => {
  const a = entry({ id: "a", time: "17:00", target: "group:wall" });
  const b = entry({ id: "b", time: "18:00", action: "standby", target: "group:lobby" });

  it("standby entries count as shutdowns and the result names the entry", () => {
    const s = sched([b]);
    expect(effectiveShutdown(s, WED_NOON)?.entry?.id).toBe("b");
  });

  it("an extension holds back only its own entry — another shutdown in between still shows as next", () => {
    const ext = new Date(2026, 0, 7, 19, 0).getTime(); // wall's 17:00 pushed to 19:00
    const s = sched([a, b], { snoozeUntil: ext, snoozeHours: 2, snoozeEntryId: "a" });
    const next = effectiveShutdown(s, WED_NOON)!;
    expect(next.entry?.id).toBe("b"); // lobby standby at 18:00 comes first
    expect(next.at.getHours()).toBe(18);
  });

  it("…and once that's past, the extended entry is next, at its extended time", () => {
    const ext = new Date(2026, 0, 7, 19, 0).getTime();
    const s = sched([a, b], { snoozeUntil: ext, snoozeHours: 2, snoozeEntryId: "a" });
    const after = new Date(2026, 0, 7, 18, 30);
    const next = effectiveShutdown(s, after)!;
    expect(next.entry?.id).toBe("a");
    expect(next.extendedHours).toBe(2);
    expect(next.at.getHours()).toBe(19);
  });

  it("nextEntry can skip an entry", () => {
    expect(nextEntry(sched([a, b]), ["power_off", "standby"], WED_NOON, "a")?.entry.id).toBe("b");
  });
});
