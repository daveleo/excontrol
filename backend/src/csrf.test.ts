import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "./config.js";
import { buildHttp } from "./api/http.js";
import { isCrossSite } from "./api/crossSite.js";

/** Regression for the CSRF found in testing: a cross-site bodyless POST from any web page
 *  (e.g. <form action="http://excontrol:8080/api/power/all/off" method="post">) switched the
 *  room off, since there's no password by default. */

const dirs: string[] = [];
let app: FastifyInstance;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "excsrf-"));
  dirs.push(dir);
  process.env.EXCONTROL_DATA_DIR = dir;
  loadConfig();
  app = await buildHttp();
});
afterAll(() => {
  for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
});

const HOST = "excontrol.local:8080";

describe("CSRF guard on /api", () => {
  it("refuses a cross-site bodyless POST (the exploit)", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/power/all/off",
      headers: { host: HOST, origin: "http://evil.example", "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" },
    });
    expect(r.statusCode).toBe(403);
  });

  it("refuses a cross-site GET with a side effect (network scan)", async () => {
    const r = await app.inject({ method: "GET", url: "/api/setup/scan", headers: { host: HOST, "sec-fetch-site": "cross-site" } });
    expect(r.statusCode).toBe(403);
  });

  it("refuses an Origin mismatch from a browser without Sec-Fetch headers", async () => {
    const r = await app.inject({ method: "POST", url: "/api/presets/x/apply", headers: { host: HOST, origin: "http://evil.example" } });
    expect(r.statusCode).toBe(403);
  });

  it("refuses Origin: null (sandboxed iframe / file:// page)", async () => {
    const r = await app.inject({ method: "POST", url: "/api/power/all/off", headers: { host: HOST, origin: "null" } });
    expect(r.statusCode).toBe(403);
  });

  it("allows the app's own page (same-origin)", async () => {
    const r = await app.inject({
      method: "PUT", url: "/api/schedule", payload: JSON.stringify({ entries: [] }),
      headers: { host: HOST, origin: `http://${HOST}`, "sec-fetch-site": "same-origin", "content-type": "application/json" },
    });
    expect(r.statusCode).toBe(200);
  });

  it("allows non-browser clients (Companion, curl): no Origin, no Sec-Fetch", async () => {
    const r = await app.inject({ method: "PUT", url: "/api/schedule", payload: JSON.stringify({ entries: [] }), headers: { host: HOST, "content-type": "application/json" } });
    expect(r.statusCode).toBe(200);
  });

  it("leaves /health and the static front-end alone", async () => {
    const r = await app.inject({ method: "GET", url: "/health", headers: { host: HOST, "sec-fetch-site": "cross-site" } });
    expect(r.statusCode).toBe(200);
  });
});

describe("clickjacking / hygiene headers", () => {
  it("every response forbids framing and sniffing", async () => {
    for (const url of ["/health", "/api/state", "/api/auth/status"]) {
      const r = await app.inject({ method: "GET", url, headers: { host: HOST } });
      expect(r.headers["x-frame-options"]).toBe("DENY");
      expect(String(r.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
    }
  });
});

describe("diagnostics zip", () => {
  it("carries no credentials — incl. the H-series pId, which alone authenticates when API encryption is off", async () => {
    await app.inject({
      method: "POST", url: "/api/setup/save", headers: { host: HOST, "content-type": "application/json" },
      payload: JSON.stringify({ devices: [
        { id: "obs", type: "obs", label: "OBS", enabled: true, host: "192.0.2.9", port: 4455, password: "S3cr3t-OBS-PW" },
        { id: "h9", type: "novastar-h", label: "H9", enabled: true, host: "192.0.2.10", port: 8000, pId: "PIDVALUE", secretKey: "SKEY1234", zones: [{ id: "s0", label: "LED", screenId: 0 }] },
      ] }),
    });
    const r = await app.inject({ method: "GET", url: "/api/diagnostics", headers: { host: HOST } });
    expect(r.statusCode).toBe(200);
    const { unzipSync, strFromU8 } = await import("fflate");
    const all = Object.values(unzipSync(r.rawPayload)).map((f) => strFromU8(f)).join("\n");
    for (const secret of ["S3cr3t-OBS-PW", "SKEY1234", "PIDVALUE"]) expect(all).not.toContain(secret);
  });
});

describe("isCrossSite", () => {
  it("dev server proxy (changeOrigin rewrites Host) is still same-origin by Sec-Fetch-Site", () => {
    expect(isCrossSite({ host: "localhost:8080", origin: "http://localhost:5173", "sec-fetch-site": "same-origin" })).toBe(false);
  });
  it("typing the URL / a bookmark (Sec-Fetch-Site: none) is allowed", () => {
    expect(isCrossSite({ host: HOST, "sec-fetch-site": "none" })).toBe(false);
  });
  it("same-site but different port is refused unless the Origin matches the Host", () => {
    expect(isCrossSite({ host: "10.0.0.5:8080", origin: "http://10.0.0.5:3000", "sec-fetch-site": "same-site" })).toBe(true);
  });
});
