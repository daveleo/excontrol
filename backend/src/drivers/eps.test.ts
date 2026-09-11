import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:net";
import { EpsDriver } from "./eps.js";
import type { EpsConfig } from "../config.js";

/** A fake EPS: tracks 6 relay bits, answers OUTx_ON/OFF, POWER_ON/OFF, POWER_STATUS, PING. */
function fakeEps(initialBits: string): Promise<{ port: number; commands: string[]; bits: () => string }> {
  const bits = initialBits.split("");
  const commands: string[] = [];
  return new Promise((resolve) => {
    const s: Server = createServer((sock) => {
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        const cmd = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        commands.push(cmd);
        const m = /^OUT([1-6])_(ON|OFF)$/.exec(cmd);
        if (m) {
          bits[Number(m[1]) - 1] = m[2] === "ON" ? "1" : "0";
          sock.end(`OK ${cmd}\n`);
        } else if (cmd === "POWER_STATUS") {
          sock.end(`SYSTEM=ON;STATE=FULLY_ON;OUTPUTS=${bits.join("")};LABEL=Test\n`);
        } else if (cmd === "POWER_ON" || cmd === "POWER_OFF") {
          sock.end(`OK ${cmd}\n`);
        } else if (cmd === "PING") {
          sock.end("PONG\n");
        } else {
          sock.end("ERR UNKNOWN_COMMAND\n");
        }
      });
    });
    servers.push(s);
    s.listen(0, "127.0.0.1", () => resolve({ port: (s.address() as { port: number }).port, commands, bits: () => bits.join("") }));
  });
}

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

async function waitFor(fn: () => boolean, tries = 40): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting for condition");
}

const baseCfg = (port: number, over: Partial<EpsConfig> = {}): EpsConfig => ({
  id: "eps", type: "expromo-eps", label: "EPS", enabled: true, host: "127.0.0.1", port,
  independentOutputs: true,
  outputs: [
    { id: "lights", label: "House lights", index: 1 },
    { id: "fog", label: "Fog", index: 3 },
  ],
  ...over,
});

describe("EPS independent output control", () => {
  it("independentOutputs off → no zones at all", () => {
    const drv = new EpsDriver(baseCfg(0, { independentOutputs: false }));
    expect(drv.zones()).toEqual([]);
  });

  it("independentOutputs on → one zone per named output, whole-unit power untouched", () => {
    const drv = new EpsDriver(baseCfg(0));
    expect(drv.zones().map((z) => ({ id: z.id, label: z.label }))).toEqual([
      { id: "lights", label: "House lights" },
      { id: "fog", label: "Fog" },
    ]);
  });

  it("refresh parses the OUTPUTS bit string into per-output on/off state", async () => {
    // bits "100000": Output 1 (lights) ON, Output 3 (fog) OFF.
    const { port } = await fakeEps("100000");
    const drv = new EpsDriver(baseCfg(port));
    await drv.start();
    await waitFor(() => drv.zones().find((z) => z.id === "lights")?.on !== undefined);
    const zones = drv.zones();
    expect(zones.find((z) => z.id === "lights")?.on).toBe(true);
    expect(zones.find((z) => z.id === "fog")?.on).toBe(false);
    await drv.stop();
  });

  it("setOn sends OUTx_ON/OFF for the right relay index, and the whole-unit power action still works", async () => {
    const { port, commands, bits } = await fakeEps("000000");
    const drv = new EpsDriver(baseCfg(port));
    await drv.setOn("fog", true); // fog = output 3
    expect(commands).toContain("OUT3_ON");
    expect(bits()[2]).toBe("1");

    await drv.setOn("lights", false); // lights = output 1, already off — no-op command still sent
    expect(commands).toContain("OUT1_OFF");

    // The old whole-device power button is a completely separate code path — unaffected.
    const reply = await drv.action("power_on");
    expect(reply).toBe("OK POWER_ON");
  });

  it("setOn rejects a zone id that isn't a configured output", async () => {
    const drv = new EpsDriver(baseCfg(0));
    await expect(drv.setOn("nope", true)).rejects.toThrow(/no output/i);
  });
});
