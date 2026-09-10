import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SECRET_KEPT, type SetupDevice } from "@excontrol/shared";
import {
  loadConfig, getConfig, applySetup, toSetupState, resolveSecrets,
} from "./config.js";

let dir: string;
const dirs: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "excfg-"));
  dirs.push(dir);
  process.env.EXCONTROL_DATA_DIR = dir;
  loadConfig(); // starts from empty
});
afterAll(() => {
  for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
});

const dev = (p: Partial<SetupDevice>): SetupDevice => ({
  id: p.id ?? "d", type: p.type ?? "expromo-eps", label: p.label ?? "D",
  enabled: p.enabled ?? true, host: p.host ?? "10.0.0.9", port: p.port ?? 5000,
  poweredBy: p.poweredBy, pId: p.pId, secretKey: p.secretKey, encrypted: p.encrypted,
  password: p.password, zones: p.zones,
});

describe("applySetup — validation", () => {
  it("rejects a missing id", () => {
    expect(() => applySetup({ devices: [dev({ id: "" })] })).toThrow(/id/i);
  });
  it("rejects an id with spaces / punctuation", () => {
    expect(() => applySetup({ devices: [dev({ id: "bad id" })] })).toThrow(/letters, digits/i);
  });
  it("rejects duplicate ids", () => {
    expect(() => applySetup({ devices: [dev({ id: "x" }), dev({ id: "x", type: "obs", port: 4455 })] })).toThrow(/duplicate/i);
  });
  it("rejects poweredBy that is not an EPS", () => {
    expect(() =>
      applySetup({ devices: [dev({ id: "o", type: "obs", port: 4455 }), dev({ id: "h", type: "novastar-h", host: "1.1.1.1", port: 8000, pId: "p", secretKey: "s", poweredBy: "o" })] }),
    ).toThrow(/not an EPS/i);
  });
  it("accepts a valid EPS + H pair and persists it", () => {
    applySetup({
      app: { name: "Site A" },
      devices: [
        dev({ id: "eps", type: "expromo-eps", host: "10.0.0.20", port: 5000 }),
        dev({ id: "h", type: "novastar-h", host: "10.0.0.10", port: 8000, pId: "abc", secretKey: "12345678", poweredBy: "eps", zones: [{ id: "m", label: "Main", screenId: 0 }] }),
      ],
    });
    const cfg = getConfig();
    expect(cfg.app.name).toBe("Site A");
    expect(cfg.devices.map((d) => d.id)).toEqual(["eps", "h"]);
    expect(existsSync(join(dir, "excontrol.config.json"))).toBe(true);
    const onDisk = JSON.parse(readFileSync(join(dir, "excontrol.config.json"), "utf8"));
    expect(onDisk.devices[1].secretKey).toBe("12345678");
  });
  it("leaves presets and schedule untouched", () => {
    applySetup({ devices: [dev({ id: "eps" })] });
    const cfg = getConfig();
    cfg.presets.push({ id: "p1", label: "P", actions: [], powerOnDefaultFor: null });
    applySetup({ devices: [dev({ id: "eps" }), dev({ id: "obs", type: "obs", port: 4455 })] });
    expect(getConfig().presets.map((p) => p.id)).toContain("p1");
  });
});

describe("secret redaction round-trip", () => {
  it("toSetupState redacts a stored secret to the sentinel", () => {
    applySetup({ devices: [dev({ id: "h", type: "novastar-h", host: "1.1.1.1", port: 8000, pId: "p", secretKey: "topsecret" })] });
    const s = toSetupState();
    const h = s.devices.find((d) => d.id === "h")!;
    expect(h.secretKey).toBe(SECRET_KEPT);
  });

  it("resolveSecrets swaps the sentinel back for the stored value", () => {
    applySetup({ devices: [dev({ id: "h", type: "novastar-h", host: "1.1.1.1", port: 8000, pId: "p", secretKey: "topsecret" })] });
    const resolved = resolveSecrets(dev({ id: "h", type: "novastar-h", host: "1.1.1.1", port: 8000, pId: "p", secretKey: SECRET_KEPT }));
    expect(resolved.secretKey).toBe("topsecret");
  });

  it("saving with the sentinel keeps the old secret; a real value replaces it", () => {
    applySetup({ devices: [dev({ id: "o", type: "obs", port: 4455, password: "orig" })] });
    applySetup({ devices: [dev({ id: "o", type: "obs", port: 4455, password: SECRET_KEPT, label: "renamed" })] });
    let obs = getConfig().devices.find((d) => d.id === "o")!;
    expect(obs.type === "obs" && obs.password).toBe("orig");
    expect(obs.label).toBe("renamed");
    applySetup({ devices: [dev({ id: "o", type: "obs", port: 4455, password: "brandnew" })] });
    obs = getConfig().devices.find((d) => d.id === "o")!;
    expect(obs.type === "obs" && obs.password).toBe("brandnew");
  });

  it("a sentinel for a device that does not exist yet resolves to empty", () => {
    const resolved = resolveSecrets(dev({ id: "new", type: "obs", port: 4455, password: SECRET_KEPT }));
    expect(resolved.password).toBe("");
  });
});

describe("zone normalisation", () => {
  it("coerces H-series screenId to a number and COEX screenId to a string", () => {
    applySetup({
      devices: [
        dev({ id: "h", type: "novastar-h", host: "1.1.1.1", port: 8000, pId: "p", secretKey: "s", zones: [{ id: "z", label: "Z", screenId: "3" as unknown as number }] }),
        dev({ id: "c", type: "novastar-coex", host: "1.1.1.2", port: 8001, zones: [{ id: "z", label: "Z", screenId: 7 as unknown as string }] }),
      ],
    });
    const cfg = getConfig();
    const h = cfg.devices.find((d) => d.id === "h")!;
    const c = cfg.devices.find((d) => d.id === "c")!;
    expect(h.type === "novastar-h" && h.zones[0]!.screenId).toBe(3);
    expect(c.type === "novastar-coex" && c.zones[0]!.screenId).toBe("7");
  });
  it("drops zones with a blank id", () => {
    applySetup({ devices: [dev({ id: "c", type: "novastar-coex", host: "1.1.1.2", port: 8001, zones: [{ id: " ", label: "x", screenId: "" }, { id: "ok", label: "OK", screenId: "" }] })] });
    const c = getConfig().devices.find((d) => d.id === "c")!;
    expect(c.type === "novastar-coex" && c.zones.map((z) => z.id)).toEqual(["ok"]);
  });
});
