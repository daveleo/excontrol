import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "./drivers/types.js";
import type { DeviceType, ZoneState } from "@excontrol/shared";
import { splitTarget, applyPreset, savePreset } from "./core/presets.js";
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
});
