import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "./drivers/types.js";
import type { DeviceType, ZoneState } from "@excontrol/shared";
import { splitTarget, applyPreset, savePreset, deletePreset } from "./core/presets.js";
import { setEntries } from "./core/schedule.js";
import { _setDriverForTest, _clearDriversForTest } from "./core/registry.js";
import { loadConfig, getConfig } from "./config.js";

describe("splitTarget", () => {
  it("bare device id", () => expect(splitTarget("h9")).toEqual(["h9", undefined]));
  it("device:zone", () => expect(splitTarget("h9:main")).toEqual(["h9", "main"]));
  it("splits on the first colon only", () => expect(splitTarget("a:b:c")).toEqual(["a", "b:c"]));
});

class FakeDriver implements Driver {
  readonly calls: Array<[string, ...unknown[]]> = [];
  constructor(
    readonly id: string,
    readonly type: DeviceType,
    private zoneList: ZoneState[] = [{ id: "z0", label: "Z" }],
  ) {}
  async start() {}
  async stop() {}
  zones() { return this.zoneList; }
  async setBrightness(zoneId: string, pct: number) { this.calls.push(["setBrightness", zoneId, pct]); }
  async recallPreset(zoneId: string, id: number) { this.calls.push(["recallPreset", zoneId, id]); }
  async setBlackout(zoneId: string, on: boolean) { this.calls.push(["setBlackout", zoneId, on]); }
  async action(name: string) { this.calls.push(["action", name]); return "ok"; }
}

const dirs: string[] = [];
let h1: FakeDriver, h2: FakeDriver, epsDrv: FakeDriver;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "excpre-"));
  dirs.push(dir);
  process.env.EXCONTROL_DATA_DIR = dir;
  loadConfig();
  _clearDriversForTest();
  h1 = new FakeDriver("h1", "novastar-h", [{ id: "main", label: "Main" }, { id: "tkr", label: "Ticker" }]);
  h2 = new FakeDriver("h2", "novastar-h");
  epsDrv = new FakeDriver("eps", "expromo-eps", []);
  _setDriverForTest(h1);
  _setDriverForTest(h2);
  _setDriverForTest(epsDrv);
});
afterAll(() => {
  for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("applyPreset", () => {
  it("applies brightness / preset / blackout to the addressed zone", async () => {
    savePreset({ id: "p", label: "Day", actions: [
      { target: "h1:main", brightness: 60, preset: 3 },
      { target: "h1:tkr", blackout: true },
    ] });
    await applyPreset("p");
    expect(h1.calls).toContainEqual(["setBrightness", "main", 60]);
    expect(h1.calls).toContainEqual(["recallPreset", "main", 3]);
    expect(h1.calls).toContainEqual(["setBlackout", "tkr", true]);
  });

  it("targets the first zone when none is named", async () => {
    savePreset({ id: "p", label: "x", actions: [{ target: "h2", brightness: 25 }] });
    await applyPreset("p");
    expect(h2.calls).toEqual([["setBrightness", "z0", 25]]);
  });

  it("routes a power action to driver.action()", async () => {
    savePreset({ id: "p", label: "x", actions: [{ target: "eps", power: "on" }] });
    await applyPreset("p");
    expect(epsDrv.calls).toEqual([["action", "power_on"]]);
  });

  it("`only` limits actions to devices in the set (power-on scope)", async () => {
    savePreset({ id: "p", label: "x", actions: [
      { target: "h1:main", brightness: 40 },
      { target: "h2", brightness: 40 },
    ] });
    await applyPreset("p", { only: new Set(["h1"]) });
    expect(h1.calls).toHaveLength(1);
    expect(h2.calls).toHaveLength(0);
  });

  it("missing preset: throws when manual, silent otherwise", async () => {
    await expect(applyPreset("nope", { manual: true })).rejects.toThrow(/no preset/);
    await expect(applyPreset("nope")).resolves.toBeUndefined();
  });

  it("a failing action doesn't abort the others", async () => {
    vi.spyOn(h1, "setBrightness").mockRejectedValueOnce(new Error("boom"));
    savePreset({ id: "p", label: "x", actions: [
      { target: "h1:main", brightness: 10 },
      { target: "h2", brightness: 10 },
    ] });
    await applyPreset("p");
    expect(h2.calls).toContainEqual(["setBrightness", "z0", 10]);
  });
});

describe("savePreset persistence", () => {
  it("writes the preset into the config file and dedupes by id", () => {
    savePreset({ id: "p", label: "First", actions: [] });
    savePreset({ id: "p", label: "Renamed", actions: [{ target: "h1", brightness: 1 }] });
    expect(getConfig().presets).toHaveLength(1);
    expect(getConfig().presets[0]!.label).toBe("Renamed");
  });

  it("'default on startup' is exclusive per target — marking a new one un-marks the old", () => {
    savePreset({ id: "day", label: "Day", actions: [], powerOnDefaultFor: "eps" });
    savePreset({ id: "night", label: "Night", actions: [], powerOnDefaultFor: "eps" });
    const presets = getConfig().presets;
    expect(presets.find((p) => p.id === "day")!.powerOnDefaultFor).toBeNull();
    expect(presets.find((p) => p.id === "night")!.powerOnDefaultFor).toBe("eps");
  });

  it("different targets don't clash — one default for a specific EPS, another for 'all'", () => {
    savePreset({ id: "stage", label: "Stage", actions: [], powerOnDefaultFor: "eps" });
    savePreset({ id: "global", label: "Global", actions: [], powerOnDefaultFor: "all" });
    const presets = getConfig().presets;
    expect(presets.find((p) => p.id === "stage")!.powerOnDefaultFor).toBe("eps");
    expect(presets.find((p) => p.id === "global")!.powerOnDefaultFor).toBe("all");
  });

  it("clearing a preset's own default doesn't touch anyone else's", () => {
    savePreset({ id: "a", label: "A", actions: [], powerOnDefaultFor: "eps" });
    savePreset({ id: "b", label: "B", actions: [], powerOnDefaultFor: "all" });
    savePreset({ id: "a", label: "A", actions: [], powerOnDefaultFor: null });
    const presets = getConfig().presets;
    expect(presets.find((p) => p.id === "a")!.powerOnDefaultFor).toBeNull();
    expect(presets.find((p) => p.id === "b")!.powerOnDefaultFor).toBe("all");
  });
});

describe("deletePreset", () => {
  it("disables a schedule entry that recalled the deleted preset", () => {
    savePreset({ id: "day", label: "Day", actions: [] });
    setEntries([
      { id: "s1", label: "Morning look", time: "08:00", days: [], action: "apply_preset", presetId: "day", enabled: true },
      { id: "s2", label: "Evening off", time: "20:00", days: [], action: "power_off", target: "all", enabled: true },
    ]);
    deletePreset("day");
    const entries = getConfig().schedule.entries;
    expect(entries.find((e) => e.id === "s1")!.enabled).toBe(false);
    expect(entries.find((e) => e.id === "s1")!.presetId).toBeUndefined();
    expect(entries.find((e) => e.id === "s2")!.enabled).toBe(true); // untouched
  });
});
