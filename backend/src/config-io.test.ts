import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import type { FastifyInstance } from "fastify";
import { loadConfig, getConfig } from "./config.js";
import { buildHttp } from "./api/http.js";
import { _resetLoginGateForTest } from "./core/auth.js";

const dirs: string[] = [];
let app: FastifyInstance;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "excio-"));
  dirs.push(dir);
  process.env.EXCONTROL_DATA_DIR = dir;
  loadConfig();
  app = await buildHttp();
  _resetLoginGateForTest();
});
afterAll(() => {
  for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
});

const json = (payload: unknown, headers: Record<string, string> = {}) => ({
  payload: JSON.stringify(payload),
  headers: { "content-type": "application/json", ...headers },
});
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

const sampleDevice = {
  id: "h9", type: "novastar-h", label: "H9", enabled: true, host: "10.0.0.10", port: 8000,
  pId: "abc", secretKey: "12345678", encrypted: false, poweredBy: null, zones: [],
};

describe("config export", () => {
  it("returns the full config with secrets, but not the settings-password hash/salt", async () => {
    await app.inject({ method: "POST", url: "/api/setup/save", ...json({ devices: [sampleDevice] }) });
    await app.inject({ method: "POST", url: "/api/auth/set-password", ...json({ newPassword: "hunter2" }) });

    const { token } = (await app.inject({ method: "POST", url: "/api/auth/login", ...json({ password: "hunter2" }) })).json();
    const r = await app.inject({ method: "GET", url: "/api/config/export", headers: bearer(token) });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-disposition"]).toMatch(/attachment/);

    const body = r.json();
    expect(body.devices[0].secretKey).toBe("12345678"); // real secret, not redacted
    expect(body.app.settingsPasswordHash).toBeUndefined();
    expect(body.app.settingsPasswordSalt).toBeUndefined();
  });

  it("requires the settings password once one is set", async () => {
    await app.inject({ method: "POST", url: "/api/auth/set-password", ...json({ newPassword: "hunter2" }) });
    expect((await app.inject({ method: "GET", url: "/api/config/export" })).statusCode).toBe(401);
  });
});

describe("config import", () => {
  it("accepts a previously-exported file and restarts devices", async () => {
    const file = { app: { name: "Imported Site", httpPort: 8080, bind: "0.0.0.0" }, devices: [sampleDevice], presets: [], schedule: { entries: [] } };
    const r = await app.inject({ method: "POST", url: "/api/config/import", ...json(file) });
    expect(r.json()).toMatchObject({ ok: true, configured: true, portChanged: false });
    expect(getConfig().devices.map((d) => d.id)).toEqual(["h9"]);
    expect(getConfig().app.name).toBe("Imported Site");
  });

  it("rejects garbage input", async () => {
    const r = await app.inject({ method: "POST", url: "/api/config/import", ...json("not an object") });
    expect(r.statusCode).toBe(400);
  });

  it("keeps this machine's settings password even if the imported file carries one", async () => {
    await app.inject({ method: "POST", url: "/api/auth/set-password", ...json({ newPassword: "local-secret" }) });
    const { token } = (await app.inject({ method: "POST", url: "/api/auth/login", ...json({ password: "local-secret" }) })).json();

    const foreignFile = {
      app: { name: "Other Site", httpPort: 8080, bind: "0.0.0.0", settingsPasswordHash: "deadbeef", settingsPasswordSalt: "beefdead" },
      devices: [sampleDevice], presets: [], schedule: { entries: [] },
    };
    const r = await app.inject({ method: "POST", url: "/api/config/import", ...json(foreignFile, bearer(token)) });
    expect(r.statusCode).toBe(200);
    // the imported password fields did NOT take over — the original password still works
    const login = await app.inject({ method: "POST", url: "/api/auth/login", ...json({ password: "local-secret" }) });
    expect(login.statusCode).toBe(200);
  });

  it("reports portChanged like setup/save does", async () => {
    const file = { app: { name: "X", httpPort: 9292, bind: "0.0.0.0" }, devices: [], presets: [], schedule: { entries: [] } };
    const r = await app.inject({ method: "POST", url: "/api/config/import", ...json(file) });
    expect(r.json()).toMatchObject({ portChanged: true, port: 9292 });
  });

  it("requires the settings password once one is set", async () => {
    await app.inject({ method: "POST", url: "/api/auth/set-password", ...json({ newPassword: "hunter2" }) });
    const r = await app.inject({ method: "POST", url: "/api/config/import", ...json({ devices: [] }) });
    expect(r.statusCode).toBe(401);
  });
});

describe("diagnostics", () => {
  it("returns a zip with the expected entries, secrets redacted", async () => {
    await app.inject({ method: "POST", url: "/api/setup/save", ...json({ devices: [sampleDevice] }) });
    const r = await app.inject({ method: "GET", url: "/api/diagnostics" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toMatch(/zip/);

    const entries = unzipSync(new Uint8Array(r.rawPayload));
    expect(Object.keys(entries)).toEqual(expect.arrayContaining(["config-redacted.json", "state.json", "system.json"]));

    const config = JSON.parse(strFromU8(entries["config-redacted.json"]!));
    expect(config.devices[0].secretKey).toBe("••••••••");

    const system = JSON.parse(strFromU8(entries["system.json"]!));
    expect(system.excontrolVersion).toBeTruthy();
    expect(system.node).toBe(process.version);
  });

  it("requires the settings password once one is set", async () => {
    await app.inject({ method: "POST", url: "/api/auth/set-password", ...json({ newPassword: "hunter2" }) });
    expect((await app.inject({ method: "GET", url: "/api/diagnostics" })).statusCode).toBe(401);
  });
});
