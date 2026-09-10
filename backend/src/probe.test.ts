import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { createServer as createTcp, type Server as TcpServer } from "node:net";
import { netReason } from "./setup/neterr.js";
import { probeDevice } from "./setup/probe.js";
import type { SetupDevice } from "@excontrol/shared";

describe("netReason", () => {
  const hp = "10.0.0.5:8000";
  it("timeout / abort → unreachable", () => {
    expect(netReason({ name: "AbortError" }, hp)?.hint).toBe("unreachable");
    expect(netReason({ code: "ETIMEDOUT" }, hp)?.hint).toBe("unreachable");
    expect(netReason({ cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }, hp)?.hint).toBe("unreachable");
  });
  it("connection refused → unreachable, mentions the port", () => {
    const r = netReason({ code: "ECONNREFUSED" }, hp);
    expect(r?.hint).toBe("unreachable");
    expect(r?.detail).toMatch(/8000/);
  });
  it("DNS failure → unreachable, suggests using an IP", () => {
    expect(netReason({ code: "ENOTFOUND" }, hp)?.detail).toMatch(/IP address/i);
  });
  it("connection reset → bad-response (protocol/encryption mismatch)", () => {
    expect(netReason({ code: "ECONNRESET" }, hp)?.hint).toBe("bad-response");
  });
  it("an unrecognised error → null (let the caller decide)", () => {
    expect(netReason({ message: "weird" }, hp)).toBeNull();
  });
});

const servers: Array<Server | TcpServer> = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

function httpStub(handler: (body: string) => unknown, status = 200): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      let b = "";
      req.on("data", (d) => (b += d));
      req.on("end", () => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(status === 200 ? JSON.stringify(handler(b)) : "nope");
      });
    });
    servers.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
  });
}
function tcpStub(onConn: (sock: import("node:net").Socket) => void): Promise<number> {
  return new Promise((resolve) => {
    const s = createTcp(onConn);
    servers.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
  });
}

const H = (port: number, over: Partial<SetupDevice> = {}): SetupDevice => ({
  id: "h", type: "novastar-h", label: "H", enabled: true, host: "127.0.0.1", port,
  pId: "pid", secretKey: "12345678", encrypted: false, ...over,
});

describe("H-series probe — decodes controller errors", () => {
  it("status 0 with a screen list → ok + zones", async () => {
    const port = await httpStub(() => ({ status: 0, body: { screens: [{ screenId: 0, name: "Wall" }, { screenId: 1 }] } }));
    const r = await probeDevice(H(port));
    expect(r.ok).toBe(true);
    expect(r.zones?.map((z) => z.label)).toEqual(["Wall", "Screen 1"]);
  });
  it("status 15 → 'disabled', explains the inverted toggle", async () => {
    const port = await httpStub(() => ({ status: 15, msg: "Open_Id_Illegal_Err" }));
    const r = await probeDevice(H(port));
    expect(r.ok).toBe(false);
    expect(r.hint).toBe("disabled");
    expect(r.detail).toMatch(/blue/i);
  });
  it("status 13 → 'misconfigured'", async () => {
    const port = await httpStub(() => ({ status: 13, msg: "Open_Project_Illegal_Err" }));
    expect((await probeDevice(H(port))).hint).toBe("misconfigured");
  });
  it("status 912 → 'booting'", async () => {
    const port = await httpStub(() => ({ status: 912, msg: "device starting" }));
    expect((await probeDevice(H(port))).hint).toBe("booting");
  });
  it("HTTP 500 / Server_Err → 'auth' (secret or encryption mismatch)", async () => {
    const port = await httpStub(() => ({ status: 500, msg: "Server_Err" }));
    const r = await probeDevice(H(port));
    expect(r.hint).toBe("auth");
    expect(r.detail).toMatch(/secret key|encryption/i);
  });
  it("missing credentials → 'misconfigured' before any network call", async () => {
    const r = await probeDevice(H(9, { pId: "", secretKey: "" }));
    expect(r.hint).toBe("misconfigured");
  });
});

describe("COEX probe", () => {
  it("screens present → ok + zones", async () => {
    const port = await httpStub(() => ({ code: 0, data: { screens: [{ screenID: "g-1", screenName: "Main" }] } }));
    const r = await probeDevice({ id: "c", type: "novastar-coex", label: "C", enabled: true, host: "127.0.0.1", port });
    expect(r.ok).toBe(true);
    expect(r.zones?.[0]?.screenId).toBe("g-1");
  });
  it("HTTP 404 → 'not a COEX box'", async () => {
    const port = await httpStub(() => ({}), 404);
    const r = await probeDevice({ id: "c", type: "novastar-coex", label: "C", enabled: true, host: "127.0.0.1", port });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/COEX/i);
  });
});

describe("EPS probe", () => {
  it("a well-formed status line → ok, surfaces the label + power state", async () => {
    const port = await tcpStub((sock) => {
      sock.on("data", () => sock.end("SYSTEM=ON;STATE=FULLY_ON;OUTPUTS=111111;LABEL=Stage\n"));
    });
    const r = await probeDevice({ id: "e", type: "expromo-eps", label: "E", enabled: true, host: "127.0.0.1", port });
    expect(r.ok).toBe(true);
    expect(r.info).toMatch(/Stage/);
    expect(r.info).toMatch(/power ON/);
  });
  it("something that answers but isn't an EPS → bad-response", async () => {
    const port = await tcpStub((sock) => sock.on("data", () => sock.end("HELLO HTTP/1.1\n")));
    const r = await probeDevice({ id: "e", type: "expromo-eps", label: "E", enabled: true, host: "127.0.0.1", port });
    expect(r.ok).toBe(false);
    expect(r.hint).toBe("bad-response");
  });
  it("connection refused → unreachable", async () => {
    const r = await probeDevice({ id: "e", type: "expromo-eps", label: "E", enabled: true, host: "127.0.0.1", port: 1 });
    expect(r.ok).toBe(false);
    expect(r.hint).toBe("unreachable");
  });
});
