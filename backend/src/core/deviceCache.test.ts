import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  rememberZones, getCachedZones, getCachedLastSeen, pruneCache, flushDeviceCache, _resetForTest,
} from "./deviceCache.js";

const dirs: string[] = [];

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "excio-cache-"));
  dirs.push(dir);
  process.env.EXCONTROL_DATA_DIR = dir;
  _resetForTest();
});
afterAll(() => {
  for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("device cache — survives a simulated restart", () => {
  it("restores last-known zones after the in-memory cache is dropped and disk is re-read", () => {
    rememberZones("h9", [{ id: "led", label: "LED", brightness: 24, presets: [{ id: 0, name: "MAIN" }] }], 1000);
    flushDeviceCache();

    _resetForTest(); // simulate the process restarting — nothing left in memory

    expect(getCachedZones("h9")).toEqual([
      { id: "led", label: "LED", brightness: 24, presets: [{ id: 0, name: "MAIN" }] },
    ]);
    expect(getCachedLastSeen("h9")).toBe(1000);
  });

  it("writes an actual file on disk, not just kept in memory", () => {
    rememberZones("h9", [{ id: "led", label: "LED" }], 1000);
    flushDeviceCache();
    const file = join(process.env.EXCONTROL_DATA_DIR!, "excontrol.device-cache.json");
    expect(existsSync(file)).toBe(true);
  });

  it("never remembers an empty zone list — that's not real data worth caching", () => {
    rememberZones("h9", [{ id: "led", label: "LED", brightness: 50 }], 1000);
    rememberZones("h9", [], 2000);
    expect(getCachedZones("h9")).toEqual([{ id: "led", label: "LED", brightness: 50 }]);
  });

  it("pruneCache drops entries for devices no longer in the config", () => {
    rememberZones("h9", [{ id: "led", label: "LED" }], 1000);
    rememberZones("gone", [{ id: "z", label: "Z" }], 1000);
    pruneCache(["h9"]);
    flushDeviceCache();
    _resetForTest();
    expect(getCachedZones("h9")).toBeDefined();
    expect(getCachedZones("gone")).toBeUndefined();
  });
});
