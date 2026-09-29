import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, getConfig, getConfigRecovery, saveConfig } from "./config.js";
import { writeFileDurable } from "./core/durableWrite.js";

/**
 * Regression tests for what the Raspberry Pi hard-reset series found (docs/TEST-REPORT):
 * a power cut left excontrol.config.json as NUL bytes; the backend then started
 * unconfigured and a later save would have destroyed the damaged file. A config that parsed
 * but failed validation made loadConfig throw → a permanent crash loop.
 */

let dir: string;
const dirs: string[] = [];
const cfgPath = () => join(dir, "excontrol.config.json");
const lastGood = () => join(dir, "excontrol.config.last-good.json");

const good = {
  app: { name: "Site", httpPort: 8080, bind: "0.0.0.0", autoStart: true },
  devices: [{ id: "eps", type: "expromo-eps", label: "EPS", enabled: true, host: "10.0.0.20", port: 5000 }],
  presets: [],
  schedule: { entries: [] },
  groups: [],
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "exrec-"));
  dirs.push(dir);
  process.env.EXCONTROL_DATA_DIR = dir;
});
afterAll(() => {
  for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("config recovery", () => {
  it("a clean load writes the last-good copy", () => {
    writeFileSync(cfgPath(), JSON.stringify(good));
    loadConfig();
    expect(getConfigRecovery()).toBeUndefined();
    expect(JSON.parse(readFileSync(lastGood(), "utf8")).devices[0].id).toBe("eps");
  });

  it("a NUL-filled config (the measured power-cut failure) is moved aside and the last good copy restored", () => {
    writeFileSync(cfgPath(), JSON.stringify(good));
    loadConfig(); // creates last-good
    writeFileSync(cfgPath(), Buffer.alloc(199)); // 199 NUL bytes, as found on the Pi
    loadConfig();
    const r = getConfigRecovery();
    expect(r?.restored).toBe(true);
    expect(getConfig().devices.map((d) => d.id)).toEqual(["eps"]);
    // restored onto disk, damaged file kept for forensics
    expect(JSON.parse(readFileSync(cfgPath(), "utf8")).devices[0].id).toBe("eps");
    expect(existsSync(join(dir, r!.keptAs))).toBe(true);
    expect(readFileSync(join(dir, r!.keptAs)).every((b) => b === 0)).toBe(true);
  });

  it("valid JSON that fails validation no longer throws out of loadConfig (was: crash loop)", () => {
    writeFileSync(cfgPath(), JSON.stringify(good));
    loadConfig();
    const bad = structuredClone(good) as typeof good & { devices: unknown[] };
    const d0 = good.devices[0]!;
    bad.devices = [d0, { ...d0 }]; // duplicate id
    writeFileSync(cfgPath(), JSON.stringify(bad));
    expect(() => loadConfig()).not.toThrow();
    expect(getConfigRecovery()?.restored).toBe(true);
    expect(getConfig().devices).toHaveLength(1);
  });

  it("with no usable last-good copy it starts unconfigured but still keeps the damaged file", () => {
    writeFileSync(cfgPath(), "{ truncated");
    loadConfig();
    const r = getConfigRecovery();
    expect(r?.restored).toBe(false);
    expect(getConfig().devices).toHaveLength(0);
    expect(existsSync(cfgPath())).toBe(false); // nothing left where a save would overwrite it…
    expect(readFileSync(join(dir, r!.keptAs), "utf8")).toBe("{ truncated"); // …because it was moved
  });

  it("the recovery notice clears on the next successful save", () => {
    writeFileSync(cfgPath(), JSON.stringify(good));
    loadConfig();
    writeFileSync(cfgPath(), "garbage");
    loadConfig();
    expect(getConfigRecovery()).toBeDefined();
    saveConfig({ ...getConfig(), app: { ...getConfig().app, name: "Renamed" } });
    expect(getConfigRecovery()).toBeUndefined();
    expect(JSON.parse(readFileSync(lastGood(), "utf8")).app.name).toBe("Renamed");
  });
});

describe("writeFileDurable", () => {
  it("replaces the file and leaves no temp file behind", () => {
    const f = join(dir, "x.json");
    writeFileDurable(f, "one");
    writeFileDurable(f, "two");
    expect(readFileSync(f, "utf8")).toBe("two");
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toHaveLength(0);
  });
});
