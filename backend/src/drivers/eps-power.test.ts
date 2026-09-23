import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { createServer, Socket, type Server } from "node:net";
import { EpsDriver, _epsTiming } from "./eps.js";
import type { EpsConfig } from "../config.js";

/**
 * A fake EPS that behaves like firmware v2.2 as measured on real hardware (2026-09-23):
 *  - POWER_ON from all-off: INIT delay, then one relay per STEP (scaled down here).
 *  - POWER_ON from PARTIAL_ON: everything off first, then the same sequence (the hazard).
 *  - OUTx while SEQUENCING: aborts the sequence (the rest never come on).
 *  - A second connection while one is open: dropped with no reply (lost command).
 */
const INIT = 40;
const STEP = 30;

interface Fake {
  port: number;
  log: { cmd: string; at: number }[];
  bits: () => string;
  maxConcurrent: () => number;
  /** outputs that went 1 → 0 at any point (to catch a running output being cut) */
  cutEvents: number[];
  dropNext: (n: number) => void;
}

function fakeEps(initial: string): Promise<Fake> {
  const bits = initial.split("");
  const log: { cmd: string; at: number }[] = [];
  const cutEvents: number[] = [];
  let sequencing = false;
  let seqTimer: NodeJS.Timeout | undefined;
  let open = 0;
  let maxConcurrent = 0;
  let drop = 0;

  const set = (i: number, v: "0" | "1") => {
    if (bits[i] === "1" && v === "0") cutEvents.push(i + 1);
    bits[i] = v;
  };
  const stopSeq = () => {
    if (seqTimer) clearTimeout(seqTimer);
    seqTimer = undefined;
    sequencing = false;
  };
  const startSeq = () => {
    if (sequencing) return;
    if (bits.every((b) => b === "1")) return;
    for (let i = 0; i < 6; i++) set(i, "0"); // the firmware's partial → all-off quirk
    sequencing = true;
    let i = 0;
    const step = () => {
      set(i, "1");
      i++;
      if (i < 6) seqTimer = setTimeout(step, STEP);
      else stopSeq();
    };
    seqTimer = setTimeout(step, INIT);
  };
  const status = () => {
    const mask = bits.join("");
    const sys = mask.includes("1") ? "ON" : "OFF";
    const state = sequencing ? "SEQUENCING" : !mask.includes("1") ? "OFF" : mask === "111111" ? "FULLY_ON" : "PARTIAL_ON";
    return `SYSTEM=${sys};STATE=${state};OUTPUTS=${mask};D5=OFF;LABEL=Fake`;
  };

  return new Promise((resolve) => {
    const s: Server = createServer((sock: Socket) => {
      // A connection counts as "open" until the unit has answered it (the firmware stops
      // the client right after replying) — not until the client's close lands later.
      open++;
      maxConcurrent = Math.max(maxConcurrent, open);
      let released = false;
      const release = () => { if (!released) { released = true; open--; } };
      sock.on("close", release);
      const origEnd = sock.end.bind(sock);
      (sock as unknown as { end: (d: string) => void }).end = (d: string) => { release(); origEnd(d); };
      if (open > 1 || drop > 0) {
        if (drop > 0) drop--;
        sock.resume(); // swallow the command (so the client's close is still seen)
        return; // the real unit: accepted, never answered — the command is lost
      }
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        const cmd = buf.slice(0, nl).trim();
        log.push({ cmd, at: Date.now() });
        const m = /^OUT([1-6])_(ON|OFF)$/.exec(cmd);
        if (m) {
          stopSeq(); // aborts a running sequence, like the firmware
          set(Number(m[1]) - 1, m[2] === "ON" ? "1" : "0");
          sock.end(`OK ${cmd}\n`);
        } else if (cmd === "POWER_STATUS") sock.end(status() + "\n");
        else if (cmd === "POWER_ON") {
          startSeq();
          sock.end("OK POWER_ON\n");
        } else if (cmd === "POWER_OFF") {
          stopSeq();
          for (let i = 0; i < 6; i++) set(i, "0");
          sock.end("OK POWER_OFF\n");
        } else sock.end("ERR UNKNOWN_COMMAND\n");
      });
    });
    servers.push(s);
    s.listen(0, "127.0.0.1", () =>
      resolve({
        port: (s.address() as { port: number }).port,
        log,
        bits: () => bits.join(""),
        maxConcurrent: () => maxConcurrent,
        cutEvents,
        dropNext: (n) => { drop = n; },
      }),
    );
  });
}

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

const saved = { ..._epsTiming };
beforeAll(() => Object.assign(_epsTiming, { stepMs: 20, sequenceTimeoutMs: 2000, retryDelaysMs: [50, 100, 150], pollIntervalMs: 15 }));
afterAll(() => Object.assign(_epsTiming, saved));

const cfg = (port: number, over: Partial<EpsConfig> = {}): EpsConfig => ({
  id: "eps", type: "expromo-eps", label: "EPS", enabled: true, host: "127.0.0.1", port, minOffSeconds: 0, ...over,
});
const sent = (f: Fake) => f.log.map((l) => l.cmd).filter((c) => c !== "POWER_STATUS");

describe("EPS power — built around the real firmware's behaviour", () => {
  it("from fully off, uses the unit's own POWER_ON sequence and waits for FULLY_ON", async () => {
    const f = await fakeEps("000000");
    const drv = new EpsDriver(cfg(f.port));
    await drv.powerOn();
    expect(sent(f)).toEqual(["POWER_ON"]);
    expect(f.bits()).toBe("111111");
  });

  it("from partly on, never sends POWER_ON (it would cut the running outputs) — only the missing ones", async () => {
    const f = await fakeEps("001000");
    const drv = new EpsDriver(cfg(f.port));
    await drv.powerOn();
    expect(sent(f)).toEqual(["OUT1_ON", "OUT2_ON", "OUT4_ON", "OUT5_ON", "OUT6_ON"]);
    expect(f.bits()).toBe("111111");
    expect(f.cutEvents).toEqual([]); // output 3 was never interrupted
  });

  it("spaces its own relay switch-ons apart (one inrush at a time)", async () => {
    const f = await fakeEps("100000");
    const drv = new EpsDriver(cfg(f.port));
    await drv.powerOn();
    const ons = f.log.filter((l) => /_ON$/.test(l.cmd));
    for (let i = 1; i < ons.length; i++) expect(ons[i]!.at - ons[i - 1]!.at).toBeGreaterThanOrEqual(18);
  });

  it("waits for a running sequence instead of aborting it with a relay command", async () => {
    const f = await fakeEps("000000");
    const drv = new EpsDriver(cfg(f.port));
    await drv.powerOn(); // gets the unit to FULLY_ON through its own sequence
    await drv.applyOutputs([undefined, undefined, false, undefined, undefined, undefined]);
    // now start a sequence behind the driver's back, and ask for output 3 during it
    f.log.length = 0;
    const raw = (cmd: string) => new Promise<void>((r) => {
      const sk = new Socket();
      sk.connect(f.port, "127.0.0.1", () => sk.write(cmd + "\r\n"));
      sk.on("data", () => sk.destroy());
      sk.on("close", () => r());
    });
    await new Promise((r) => setTimeout(r, 60)); // let the driver's own refresh finish first
    await raw("POWER_OFF");
    await raw("POWER_ON");
    await drv.applyOutputs([undefined, undefined, true, undefined, undefined, undefined]);
    expect(f.bits()).toBe("111111"); // the sequence finished; nothing was aborted
  });

  it("never opens two connections at once, even with a poll and several commands racing", async () => {
    const f = await fakeEps("000000");
    const drv = new EpsDriver(cfg(f.port, { independentOutputs: true, outputs: [
      { id: "a", label: "A", index: 1 }, { id: "b", label: "B", index: 2 }, { id: "c", label: "C", index: 3 },
    ] }));
    await drv.start();
    await Promise.all([drv.setOn("a", true), drv.setOn("b", true), drv.setOn("c", true), drv.action("status")]);
    await drv.stop();
    expect(f.maxConcurrent()).toBe(1);
    expect(f.bits().slice(0, 3)).toBe("111");
  });

  it("retries a command the unit silently dropped, and verifies it", async () => {
    const f = await fakeEps("000000");
    const drv = new EpsDriver(cfg(f.port));
    f.dropNext(1); // the first connection vanishes — like colliding with another controller
    await drv.applyOutputs([true, undefined, undefined, undefined, undefined, undefined]);
    expect(f.bits()[0]).toBe("1");
  }, 15_000);

  it("power off leaves protected outputs alone (switches the rest one by one)", async () => {
    const f = await fakeEps("111111");
    const drv = new EpsDriver(cfg(f.port, { outputs: [{ id: "net", label: "Network switch", index: 5, protected: true }] }));
    await drv.powerOff();
    expect(f.bits()).toBe("000010");
    expect(sent(f)).not.toContain("POWER_OFF");
  });

  it("power off with nothing protected uses POWER_OFF", async () => {
    const f = await fakeEps("111111");
    const drv = new EpsDriver(cfg(f.port));
    await drv.powerOff();
    expect(sent(f)).toEqual(["POWER_OFF"]);
    expect(f.bits()).toBe("000000");
  });

  it("holds a switch-on back until the minimum off-time has passed", async () => {
    const f = await fakeEps("111111");
    const drv = new EpsDriver(cfg(f.port, { minOffSeconds: 0.3 }));
    await drv.powerOff();
    const t0 = Date.now();
    await drv.powerOn();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(f.bits()).toBe("111111");
  });
});
