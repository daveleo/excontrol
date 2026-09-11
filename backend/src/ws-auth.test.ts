import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "./config.js";
import { buildHttp } from "./api/http.js";
import { attachWs } from "./api/ws.js";
import { setPassword } from "./core/auth.js";

const dirs: string[] = [];
let app: FastifyInstance;
let port: number;
let detach: () => void;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "exws-"));
  dirs.push(dir);
  process.env.EXCONTROL_DATA_DIR = dir;
  loadConfig();
  app = await buildHttp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as { port: number }).port;
  detach = attachWs(app.server);
});
afterEach(async () => {
  detach();
  await app.close();
});
afterEach(() => {
  for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
});

function tryConnect(token?: string): Promise<{ opened: boolean; code?: number }> {
  return new Promise((resolve) => {
    const url = `ws://127.0.0.1:${port}/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    const ws = new WebSocket(url);
    ws.on("open", () => {
      ws.close();
      resolve({ opened: true });
    });
    ws.on("unexpected-response", (_req, res) => resolve({ opened: false, code: res.statusCode }));
    ws.on("error", () => resolve({ opened: false }));
  });
}

describe("/ws access gate", () => {
  it("connects with no token when nothing is locked", async () => {
    const r = await tryConnect();
    expect(r.opened).toBe(true);
  });

  it("rejects the handshake once a password is set — no token, and a bad token", async () => {
    await setPassword("hunter2");
    expect((await tryConnect()).opened).toBe(false);
    expect((await tryConnect("not-a-real-token")).opened).toBe(false);
  });

  it("accepts a valid token as a query param once locked", async () => {
    await setPassword("hunter2");
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: JSON.stringify({ password: "hunter2" }), headers: { "content-type": "application/json" } });
    const { token } = login.json();
    expect((await tryConnect(token)).opened).toBe(true);
  });
});
