import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceState } from "@excontrol/shared";
import { store } from "./state.js";
import { bus } from "./bus.js";
import { getCachedZones, getCachedExtra, _resetForTest as resetCache } from "./deviceCache.js";

const dirs: string[] = [];

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "excio-state-"));
  dirs.push(dir);
  process.env.EXCONTROL_DATA_DIR = dir;
  resetCache();
});
afterAll(() => {
  resetCache(); // cancel any pending debounced write before its tmp dir is removed
  for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
});

const seedDevice = (zones: DeviceState["zones"]): DeviceState => ({
  id: "h9", type: "novastar-h", label: "H9", status: "connecting", zones,
});

describe("store — a bare zone rebuild doesn't blank out cache-restored data", () => {
  it("keeps brightness/presets when a driver's first patch only knows id + label", () => {
    store.init([
      seedDevice([{ id: "led", label: "LED", brightness: 24, presets: [{ id: 0, name: "MAIN" }] }]),
    ]);

    // mirrors NovastarHDriver.ensureZones()'s bare `{ id, label }` rebuild on its first poll
    bus.emit("device:patch", { id: "h9", status: "connecting", zones: [{ id: "led", label: "LED (renamed)" }] });

    expect(store.get("h9")?.zones).toEqual([
      { id: "led", label: "LED (renamed)", brightness: 24, presets: [{ id: 0, name: "MAIN" }] },
    ]);
  });

  it("an explicit-undefined field (EPS's `on: undefined` placeholder) doesn't clobber a known value", () => {
    store.init([seedDevice([{ id: "o1", label: "Relay 1", on: true }])]);

    bus.emit("device:patch", { id: "h9", status: "connecting", zones: [{ id: "o1", label: "Relay 1", on: undefined }] });

    expect(store.get("h9")?.zones).toEqual([{ id: "o1", label: "Relay 1", on: true }]);
  });

  it("a genuinely fresh value does overwrite the cached one", () => {
    store.init([seedDevice([{ id: "led", label: "LED", brightness: 24 }])]);
    bus.emit("device:patch", { id: "h9", status: "online", zones: [{ id: "led", label: "LED", brightness: 80 }] });
    expect(store.get("h9")?.zones[0]?.brightness).toBe(80);
  });
});

describe("store — confirmed-online zone data feeds the on-disk device cache", () => {
  it("persists zones once a device reports online", () => {
    store.init([seedDevice([])]);
    bus.emit("device:patch", { id: "h9", status: "online", zones: [{ id: "led", label: "LED", brightness: 50 }] });
    expect(getCachedZones("h9")).toEqual([{ id: "led", label: "LED", brightness: 50 }]);
  });

  it("does not cache while merely connecting/offline", () => {
    store.init([seedDevice([])]);
    bus.emit("device:patch", { id: "h9", status: "connecting", zones: [{ id: "led", label: "LED", brightness: 50 }] });
    expect(getCachedZones("h9")).toBeUndefined();
  });

  it("also persists an EPS's extra status fields (SYSTEM/STATE/OUTPUTS), not just zones", () => {
    store.init([{ id: "eps", type: "expromo-eps", label: "Power", status: "connecting", zones: [] }]);
    bus.emit("device:patch", {
      id: "eps", status: "online", zones: [{ id: "o1", label: "Relay 1", on: true }],
      extra: { system: "ON", state: "FULLY_ON", outputs: "111111" },
    });
    expect(getCachedExtra("eps")).toEqual({ system: "ON", state: "FULLY_ON", outputs: "111111" });
  });
});
