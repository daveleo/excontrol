import { describe, it, expect, afterEach, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDevices, stopDevices } from "./registry.js";
import { store } from "./state.js";
import { rememberZones, _resetForTest as resetCache } from "./deviceCache.js";
import type { AppConfig } from "../config.js";

// startDevices()/stopDevices() touch the on-disk device cache (deviceCache.ts) — give every
// test in this file its own EXCONTROL_DATA_DIR so none of it lands in the real dev config/
// folder or leaks between tests.
const dirs: string[] = [];
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "excio-registry-"));
  dirs.push(dir);
  process.env.EXCONTROL_DATA_DIR = dir;
  resetCache();
});
afterEach(async () => {
  await stopDevices();
});
afterAll(() => {
  for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
});

const cfg = (): AppConfig => ({
  app: { name: "Test", httpPort: 8080, bind: "0.0.0.0", autoStart: true },
  devices: [
    { id: "eps-on", type: "expromo-eps", label: "Enabled EPS", enabled: true, host: "127.0.0.1", port: 1 },
    { id: "eps-off", type: "expromo-eps", label: "Disabled EPS", enabled: false, host: "127.0.0.1", port: 1 },
  ],
  presets: [],
  schedule: { entries: [] },
});

describe("startDevices — disabled devices are hidden, not just marked offline", () => {
  it("does not seed a card for a disabled device at all", async () => {
    await startDevices(cfg());
    const ids = store.all().map((d) => d.id);
    expect(ids).toContain("eps-on");
    expect(ids).not.toContain("eps-off");
  });
});

describe("startDevices — seeds from the on-disk device cache before anything is polled", () => {
  const hCfg = (): AppConfig => ({
    app: { name: "Test", httpPort: 8080, bind: "0.0.0.0", autoStart: true },
    devices: [
      {
        id: "h9", type: "novastar-h", label: "H9", enabled: true, host: "127.0.0.1", port: 1,
        pId: "x", secretKey: "12345678", zones: [{ id: "led", label: "LED", screenId: 0 }],
      },
    ],
    presets: [],
    schedule: { entries: [] },
  });

  it("shows last-known brightness/presets immediately, before the device answers a single poll", async () => {
    rememberZones("h9", [{ id: "led", label: "LED (cached)", brightness: 24, presets: [{ id: 0, name: "MAIN" }] }], 1000);

    await startDevices(hCfg());

    const zones = store.get("h9")?.zones ?? [];
    expect(zones.find((z) => z.id === "led")?.brightness).toBe(24);
    expect(zones.find((z) => z.id === "led")?.presets).toEqual([{ id: 0, name: "MAIN" }]);
  });
});
