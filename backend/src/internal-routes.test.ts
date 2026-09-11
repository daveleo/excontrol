import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "./config.js";
import { buildHttp } from "./api/http.js";

const dirs: string[] = [];
let app: FastifyInstance;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "exint-"));
  dirs.push(dir);
  process.env.EXCONTROL_DATA_DIR = dir;
  loadConfig();
  app = await buildHttp();
});
afterAll(() => {
  for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
});

const json = (payload: unknown) => ({ payload: JSON.stringify(payload), headers: { "content-type": "application/json" } });

// Regression coverage for a real bug: a non-async Fastify preHandler that returns
// undefined (instead of a resolved promise or calling a callback) satisfies neither the
// callback-style nor the promise-style hook contract, and the request just hangs forever
// — vitest's default per-test timeout is what actually catches that here.
describe("localhost-only internal routes resolve (don't hang)", () => {
  it("/api/internal/reload responds from localhost", async () => {
    const r = await app.inject({ method: "POST", url: "/api/internal/reload" });
    expect(r.statusCode).toBe(200);
  });

  it("/api/internal/update-status responds from localhost and updates state", async () => {
    const r = await app.inject({ method: "POST", url: "/api/internal/update-status", ...json({ available: true, version: "9.9.9", notes: "x" }) });
    expect(r.statusCode).toBe(200);

    const state = (await app.inject({ method: "GET", url: "/api/state" })).json();
    expect(state.updateInfo).toMatchObject({ available: true, version: "9.9.9" });
  });

  it("rejects a request that isn't from localhost", async () => {
    const r = await app.inject({ method: "POST", url: "/api/internal/reload", remoteAddress: "10.0.0.5" });
    expect(r.statusCode).toBe(403);
  });
});
