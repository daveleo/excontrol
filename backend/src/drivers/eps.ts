import { Socket } from "node:net";
import { BaseDriver } from "./types.js";
import type { EpsConfig } from "../config.js";
import type { ProbeResult } from "@excontrol/shared";
import { netReason } from "../setup/neterr.js";

/**
 * Expromo EPS — plain TCP on :5000.
 * Commands: POWER_ON | POWER_OFF | POWER_STATUS | PING
 * POWER_STATUS returns a k=v;k=v line, e.g.
 *   SYSTEM=ON;STATE=FULLY_ON;OUTPUTS=111111;D5=OFF;IP=…;MODE=STATIC;NET=OK;LABEL=…
 * The connection is not guaranteed to close after a reply, so we resolve on the first
 * newline (or a short idle) and close from our side.
 */
const ACTIONS: Record<string, string> = {
  power_on: "POWER_ON",
  power_off: "POWER_OFF",
  status: "POWER_STATUS",
  ping: "PING",
};

function parseStatus(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of line.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return out;
}

export class EpsDriver extends BaseDriver {
  private readonly c: EpsConfig;

  constructor(cfg: EpsConfig) {
    super(cfg);
    this.c = cfg;
    this.zoneState = []; // EPS has no zones
  }

  async start(): Promise<void> {
    this.patch({ status: "connecting", zones: [] });
    this.startPolling(() => this.refresh());
  }

  /** One-shot connection test for the setup wizard. Never polls. */
  static async probe(cfg: EpsConfig): Promise<ProbeResult> {
    return new EpsDriver(cfg).probeOnce();
  }

  private async probeOnce(): Promise<ProbeResult> {
    const hp = `${this.c.host}:${this.c.port}`;
    try {
      const raw = await this.send("POWER_STATUS");
      const f = parseStatus(raw);
      if (!("system" in f) && !("state" in f)) {
        return { ok: false, hint: "bad-response", detail: `${hp} answered, but not like an EPS unit (got "${raw.slice(0, 60)}").` };
      }
      const bits = [
        f.system ? `power ${f.system}` : null,
        f.state && f.state !== f.system ? f.state.toLowerCase().replace(/_/g, " ") : null,
        f.outputs ? `outputs ${f.outputs}` : null,
      ].filter(Boolean);
      return {
        ok: true,
        hint: "ok",
        detail: "Connected to the EPS unit.",
        info: [f.label, bits.join(", ")].filter(Boolean).join(" — ") || undefined,
      };
    } catch (e) {
      const net = netReason(e, hp);
      if (net) return { ok: false, ...net };
      const msg = e instanceof Error ? e.message : String(e);
      if (/EPS timeout/.test(msg))
        return { ok: false, hint: "unreachable", detail: `${hp} accepted the connection but never replied — check that this is an EPS unit on port 5000.` };
      return { ok: false, hint: "bad-response", detail: `Unexpected error talking to ${hp}: ${msg}` };
    }
  }

  async action(name: string): Promise<string> {
    const cmd = ACTIONS[name];
    if (!cmd) throw new Error(`unknown EPS action "${name}"`);
    const reply = await this.send(cmd);
    void this.refresh().catch(() => {});
    return reply;
  }

  private async refresh(): Promise<void> {
    const raw = await this.send("POWER_STATUS");
    const f = parseStatus(raw);
    this.online({
      extra: {
        raw,
        system: f.system ?? null,
        state: f.state ?? null,
        outputs: f.outputs ?? null,
        net: f.net ?? null,
        label: f.label ?? null,
      },
    });
  }

  private send(cmd: string, timeoutMs = 4000): Promise<string> {
    return new Promise((resolve, reject) => {
      const sock = new Socket();
      let buf = "";
      let settled = false;
      let idle: NodeJS.Timeout | undefined;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (idle) clearTimeout(idle);
        sock.removeAllListeners();
        sock.destroy();
        fn();
      };
      sock.setTimeout(timeoutMs);
      sock.on("timeout", () => finish(() => (buf ? resolve(buf.trim()) : reject(new Error("EPS timeout")))));
      sock.on("error", (e) => finish(() => reject(e)));
      sock.on("close", () => finish(() => resolve(buf.trim())));
      sock.on("data", (d) => {
        buf += d.toString("utf8");
        if (buf.includes("\n")) return finish(() => resolve(buf.trim()));
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => finish(() => resolve(buf.trim())), 250);
      });
      sock.connect(this.c.port, this.c.host, () => sock.write(cmd + "\r\n"));
    });
  }
}
