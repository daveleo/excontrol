import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "./config.js";
import { buildHttp } from "./api/http.js";
import { _resetLoginGateForTest } from "./core/auth.js";

const dirs: string[] = [];
let app: FastifyInstance;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "exhttp-"));
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

describe("settings lock — unlocked by default", () => {
  it("status reports unlocked and setup/presets/schedule are reachable with no token", async () => {
    expect((await app.inject({ method: "GET", url: "/api/auth/status" })).json()).toEqual({ locked: false });
    expect((await app.inject({ method: "GET", url: "/api/setup/state" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/presets", ...json({ label: "x" }) })).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url: "/api/schedule", ...json({ entries: [] }) })).statusCode).toBe(200);
  });

  it("/health and the auth endpoints themselves stay open even once locked", async () => {
    await app.inject({ method: "POST", url: "/api/auth/set-password", ...json({ newPassword: "hunter2" }) });
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/auth/status" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/auth/login", ...json({ password: "wrong" }) })).statusCode).toBe(401); // reachable, just rejected
  });
});

describe("settings lock — set, login, gated routes", () => {
  beforeEach(async () => {
    const r = await app.inject({ method: "POST", url: "/api/auth/set-password", ...json({ newPassword: "hunter2" }) });
    expect(r.json()).toEqual({ ok: true, locked: true });
  });

  it("the whole control surface 401s with no token, and with a wrong token", async () => {
    interface Req { method: "GET" | "POST" | "PUT" | "DELETE"; url: string; payload?: string; headers?: Record<string, string> }
    const reqs: Req[] = [
      { method: "GET", url: "/api/state" },
      { method: "GET", url: "/api/setup/state" },
      { method: "POST", url: "/api/setup/probe", ...json({ type: "obs" }) },
      { method: "GET", url: "/api/setup/scan" },
      { method: "POST", url: "/api/setup/save", ...json({ devices: [] }) },
      { method: "GET", url: "/api/presets" },
      { method: "POST", url: "/api/presets", ...json({ label: "x" }) },
      { method: "DELETE", url: "/api/presets/x" },
      { method: "POST", url: "/api/presets/x/apply" },
      { method: "GET", url: "/api/schedule" },
      { method: "PUT", url: "/api/schedule", ...json({ entries: [] }) },
      { method: "POST", url: "/api/schedule/snooze", ...json({ clear: true }) },
      { method: "POST", url: "/api/power/all/on" },
      { method: "POST", url: "/api/devices/x/zones/-/brightness", ...json({ brightness: 50 }) },
      { method: "POST", url: "/api/devices/x/zones/-/preset", ...json({ presetId: 1 }) },
      { method: "POST", url: "/api/devices/x/zones/-/blackout", ...json({ blackout: true }) },
      { method: "POST", url: "/api/devices/x/action/power_on" },
    ];
    for (const req of reqs) {
      expect((await app.inject(req)).statusCode, req.url).toBe(401);
      const withBadToken = { ...req, headers: { ...req.headers, ...bearer("not-a-real-token") } };
      expect((await app.inject(withBadToken)).statusCode, req.url).toBe(401);
    }
  });

  it("login with the wrong password fails; the right one issues a working token", async () => {
    expect((await app.inject({ method: "POST", url: "/api/auth/login", ...json({ password: "nope" }) })).statusCode).toBe(401);
    const r = await app.inject({ method: "POST", url: "/api/auth/login", ...json({ password: "hunter2" }) });
    expect(r.statusCode).toBe(200);
    const { token } = r.json();
    expect(typeof token).toBe("string");

    expect((await app.inject({ method: "GET", url: "/api/setup/state", headers: bearer(token) })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/auth/verify", headers: bearer(token) })).json()).toEqual({ valid: true });
  });

  it("a valid token unlocks the whole control surface, not just settings", async () => {
    const { token } = (await app.inject({ method: "POST", url: "/api/auth/login", ...json({ password: "hunter2" }) })).json();
    expect((await app.inject({ method: "GET", url: "/api/state", headers: bearer(token) })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/presets", headers: bearer(token) })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/schedule", headers: bearer(token) })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/schedule/snooze", ...json({ clear: true }, bearer(token)) })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/power/all/on", headers: bearer(token) })).statusCode).not.toBe(401);
  });

  it("changing the password requires the current one and revokes old tokens", async () => {
    const { token } = (await app.inject({ method: "POST", url: "/api/auth/login", ...json({ password: "hunter2" }) })).json();

    const wrong = await app.inject({ method: "POST", url: "/api/auth/set-password", ...json({ currentPassword: "bad", newPassword: "new" }, bearer(token)) });
    expect(wrong.statusCode).toBe(400);

    const changed = await app.inject({ method: "POST", url: "/api/auth/set-password", ...json({ currentPassword: "hunter2", newPassword: "new" }, bearer(token)) });
    expect(changed.statusCode).toBe(200);

    // the pre-change token is dead
    expect((await app.inject({ method: "GET", url: "/api/setup/state", headers: bearer(token) })).statusCode).toBe(401);
    // the old password no longer works, the new one does
    expect((await app.inject({ method: "POST", url: "/api/auth/login", ...json({ password: "hunter2" }) })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/auth/login", ...json({ password: "new" }) })).statusCode).toBe(200);
  });

  it("removing the password (newPassword: null) unlocks everything again", async () => {
    const { token } = (await app.inject({ method: "POST", url: "/api/auth/login", ...json({ password: "hunter2" }) })).json();
    const r = await app.inject({ method: "POST", url: "/api/auth/set-password", ...json({ currentPassword: "hunter2", newPassword: null }, bearer(token)) });
    expect(r.json()).toEqual({ ok: true, locked: false });
    expect((await app.inject({ method: "GET", url: "/api/setup/state" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/auth/status" })).json()).toEqual({ locked: false });
  });

  it("cannot set-password without being unlocked first", async () => {
    const r = await app.inject({ method: "POST", url: "/api/auth/set-password", ...json({ newPassword: "whatever" }) });
    expect(r.statusCode).toBe(401);
  });
});

describe("configurable port", () => {
  it("rejects an out-of-range port", async () => {
    const r = await app.inject({ method: "POST", url: "/api/setup/save", ...json({ app: { httpPort: 999999 }, devices: [] }) });
    expect(r.statusCode).toBe(400);
  });

  it("reports portChanged and the new port when app.httpPort differs", async () => {
    const r = await app.inject({ method: "POST", url: "/api/setup/save", ...json({ app: { httpPort: 9191 }, devices: [] }) });
    const body = r.json();
    expect(body).toMatchObject({ ok: true, portChanged: true, port: 9191 });
  });

  it("does not report portChanged when only devices change", async () => {
    const r = await app.inject({ method: "POST", url: "/api/setup/save", ...json({ devices: [] }) });
    expect(r.json()).toMatchObject({ portChanged: false });
  });
});

describe("login rate limiting", () => {
  beforeEach(async () => {
    await app.inject({ method: "POST", url: "/api/auth/set-password", ...json({ newPassword: "hunter2" }) });
  });

  it("locks out after 5 failures within the window, and a correct password still fails while locked", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({ method: "POST", url: "/api/auth/login", ...json({ password: "wrong" }) });
      expect(r.statusCode).toBe(401);
    }
    const locked = await app.inject({ method: "POST", url: "/api/auth/login", ...json({ password: "hunter2" }) });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error).toMatch(/too many attempts/i);
  });

  it("a successful login clears the failure count", async () => {
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: "POST", url: "/api/auth/login", ...json({ password: "wrong" }) });
    }
    expect((await app.inject({ method: "POST", url: "/api/auth/login", ...json({ password: "hunter2" }) })).statusCode).toBe(200);
    // 3 more wrong attempts right after a success shouldn't trip the 5-attempt threshold
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({ method: "POST", url: "/api/auth/login", ...json({ password: "wrong" }) });
      expect(r.statusCode).toBe(401);
    }
  });

  it("also gates set-password's current-password check", async () => {
    const { token } = (await app.inject({ method: "POST", url: "/api/auth/login", ...json({ password: "hunter2" }) })).json();
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: "POST", url: "/api/auth/set-password", ...json({ currentPassword: "wrong", newPassword: "x" }, bearer(token)) });
    }
    const r = await app.inject({ method: "POST", url: "/api/auth/set-password", ...json({ currentPassword: "hunter2", newPassword: "x" }, bearer(token)) });
    expect(r.statusCode).toBe(429);
  });
});
