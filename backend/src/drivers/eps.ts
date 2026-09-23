import { Socket } from "node:net";
import { BaseDriver } from "./types.js";
import type { EpsConfig } from "../config.js";
import type { ProbeResult } from "@excontrol/shared";
import { netReason } from "../setup/neterr.js";
import { toast } from "../core/bus.js";

/**
 * Expromo EPS — plain TCP on :5000.
 * Commands: POWER_ON | POWER_OFF | POWER_STATUS | PING | OUTx_ON | OUTx_OFF
 * POWER_STATUS returns a k=v;k=v line, e.g.
 *   SYSTEM=ON;STATE=FULLY_ON;OUTPUTS=111111;D5=OFF;IP=…;MODE=STATIC;NET=OK;LABEL=…
 * The connection is not guaranteed to close after a reply, so we resolve on the first
 * newline (or a short idle) and close from our side.
 *
 * ---- Hardware facts this driver is built around (firmware v2.2, measured 2026-09-23) ----
 *
 * - POWER_ON: 1 s start delay, then OUT1..OUT6 one every 300 ms (FULLY_ON at ~2.6 s).
 *   POWER_OFF drops all six at once (zero-cross SSRs — no inrush on switch-off).
 * - POWER_ON on a PARTIAL_ON unit first switches *everything* off, then re-sequences — so
 *   equipment that was already running loses power for ~1 s. powerOn() therefore never sends
 *   POWER_ON unless the unit is fully off; otherwise it switches on only the missing outputs.
 * - An OUTx command sent while SEQUENCING aborts the sequence (the rest never come on) — so
 *   relay commands wait for the sequence to finish.
 * - OUTx commands take effect instantly with no spacing — six in a row is six loads in 45 ms.
 *   We space switch-ons STEP_MS apart ourselves, matching the unit's own sequence.
 * - Two connections at once can make the unit drop *both*, and then ignore everything for
 *   up to ~10 s. Every connection from this driver therefore goes through one queue, polls
 *   step aside while a command is pending, and commands are verified by reading the status
 *   back and retried — repeating one is harmless (POWER_ON on a FULLY_ON unit is a no-op).
 *   Other controllers (Crestron, Q-SYS, the unit's own web page) can still collide with us;
 *   the retry is what keeps that from losing a command.
 */
const RAW: Record<string, string> = {
  status: "POWER_STATUS",
  ping: "PING",
};

/** spacing between two relay switch-ons we issue ourselves — the unit's own step */
const STEP_MS = 300;
/** POWER_ON → FULLY_ON is ~2.6 s; allow margin before calling it a failure */
const SEQUENCE_TIMEOUT_MS = 6000;
const RETRY_DELAYS_MS = [400, 1200, 2500];
/** default minimum time a relay stays off before we switch it back on (NTC inrush limiters
 *  in the loads recover; processors and Android screens aren't hard-cycled) */
const DEFAULT_MIN_OFF_MS = 30_000;

export interface EpsStatus {
  system?: string;
  state?: string;
  /** "010111" — index 0 is OUT1 */
  outputs?: string;
  raw: string;
}

function parseStatus(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of line.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** test hook — shrink the real-world timings so the suite doesn't take minutes */
export const _epsTiming = { stepMs: STEP_MS, sequenceTimeoutMs: SEQUENCE_TIMEOUT_MS, retryDelaysMs: RETRY_DELAYS_MS, pollIntervalMs: 250 };

export class EpsDriver extends BaseDriver {
  private readonly c: EpsConfig;
  /** every socket to the unit goes through this chain — never two at once */
  private chain: Promise<unknown> = Promise.resolve();
  /** commands waiting or running; polls skip while > 0 */
  private pendingCommands = 0;
  /** last time each output (1-6) was seen or made to go off, for the minimum off-time */
  private lastOff = new Map<number, number>();
  private lastBits: string | undefined;
  readonly minOffMs: number;

  constructor(cfg: EpsConfig) {
    super(cfg);
    this.c = cfg;
    this.pollFailThreshold = 3;
    this.minOffMs = cfg.minOffSeconds != null ? Math.max(0, cfg.minOffSeconds) * 1000 : DEFAULT_MIN_OFF_MS;
    // With independent output control enabled, each named relay is exposed as a plain
    // on/off zone; the whole-unit Power on/off button (action("power_on"/"power_off"))
    // is unaffected either way.
    this.zoneState = this.c.independentOutputs
      ? (this.c.outputs ?? []).map((o) => ({ id: o.id, label: o.label, on: undefined }))
      : [];
  }

  async start(): Promise<void> {
    this.patch({ status: "connecting", zones: this.zoneState });
    this.startPolling(() => this.refresh());
  }

  /** setOn zone -> physical relay index. */
  private outputIndex(zoneId: string): number {
    const o = (this.c.outputs ?? []).find((x) => x.id === zoneId);
    if (!o) throw new Error(`${this.id}: no output "${zoneId}"`);
    return o.index;
  }

  private protectedOutputs(): Set<number> {
    return new Set((this.c.outputs ?? []).filter((o) => o.protected).map((o) => o.index));
  }

  /** The per-output button (independent output control). Deliberately *not* blocked for
   *  protected outputs — that's the one place an installer can still switch one. */
  async setOn(zoneId: string, on: boolean): Promise<void> {
    const idx = this.outputIndex(zoneId);
    const desired: (boolean | undefined)[] = Array(6).fill(undefined);
    desired[idx - 1] = on;
    await this.driveOutputs(desired, { allowProtectedOff: true });
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
    if (name === "power_on") {
      await this.powerOn();
      return "OK POWER_ON";
    }
    if (name === "power_off") {
      await this.powerOff();
      return "OK POWER_OFF";
    }
    const cmd = RAW[name];
    if (!cmd) throw new Error(`unknown EPS action "${name}"`);
    return this.command(cmd);
  }

  /** Whole unit on, safely: POWER_ON only from fully off (the unit's own sequence), else just
   *  the missing outputs, spaced. Resolves once the outputs are verified on. */
  async powerOn(): Promise<void> {
    await this.driveOutputs(Array(6).fill(true));
  }

  /** Whole unit off, except protected outputs. Verified. */
  async powerOff(): Promise<void> {
    await this.driveOutputs(Array(6).fill(false));
  }

  /** The engine's entry point — see Driver.applyOutputs. Protected outputs are never
   *  switched off from here. */
  async applyOutputs(desired: (boolean | undefined)[]): Promise<void> {
    await this.driveOutputs(desired);
  }

  private async driveOutputs(desired: (boolean | undefined)[], opts: { allowProtectedOff?: boolean } = {}): Promise<void> {
    this.pendingCommands++;
    try {
      const prot = opts.allowProtectedOff ? new Set<number>() : this.protectedOutputs();
      const want = desired.map((v, i) => (v === false && prot.has(i + 1) ? undefined : v));

      let st = await this.waitNotSequencing();
      let bits = st.outputs ?? "000000";

      // 1) switch-offs first — no inrush, and frees the supply before anything comes on.
      const offs = want.map((v, i) => (v === false && bits[i] === "1" ? i + 1 : 0)).filter(Boolean);
      if (offs.length) {
        // POWER_OFF only for an explicit whole-unit off (it also clears the unit's own
        // "restore after reboot" memory); single relays use OUTx.
        if (want.every((v) => v === false)) await this.verified("POWER_OFF", (s) => !!s.outputs && !s.outputs.includes("1"));
        else for (const i of offs) await this.verified(`OUT${i}_OFF`, (s) => s.outputs?.[i - 1] === "0");
        const now = Date.now();
        for (const i of offs) this.lastOff.set(i, now);
        st = await this.readStatus();
        bits = st.outputs ?? bits;
      }

      // 2) switch-ons, respecting the minimum off-time.
      const ons = want.map((v, i) => (v === true && bits[i] === "0" ? i + 1 : 0)).filter(Boolean);
      if (!ons.length) return;
      await this.waitMinOff(ons);
      const fullyOff = !bits.includes("1");
      if (fullyOff && ons.length === 6) {
        // The unit's own hardware-timed sequence — the best thing it does.
        await this.verified("POWER_ON", (s) => s.state === "SEQUENCING" || !!s.outputs?.includes("1"));
        const done = await this.waitNotSequencing();
        if (done.outputs !== "111111") {
          throw new Error(`${this.c.label}: sequence ended at ${done.outputs ?? "?"}, not all on`);
        }
        return;
      }
      for (let n = 0; n < ons.length; n++) {
        const i = ons[n]!;
        if (n > 0) await sleep(_epsTiming.stepMs);
        await this.verified(`OUT${i}_ON`, (s) => s.outputs?.[i - 1] === "1");
      }
    } finally {
      this.pendingCommands--;
      void this.refresh().catch(() => {});
    }
  }

  private async waitMinOff(outputs: number[]): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, ...outputs.map((i) => (this.lastOff.get(i) ?? 0) + this.minOffMs - now));
    if (wait <= 0) return;
    toast("info", `${this.c.label}: waiting ${Math.ceil(wait / 1000)} s minimum off-time before switching on`);
    this.log.info({ waitMs: wait, outputs }, "minimum off-time — delaying switch-on");
    await sleep(wait);
  }

  /** Poll until the unit isn't mid-sequence (so a relay command can't abort it). */
  private async waitNotSequencing(): Promise<EpsStatus> {
    const deadline = Date.now() + _epsTiming.sequenceTimeoutMs;
    let st = await this.readStatus();
    while (st.state === "SEQUENCING" && Date.now() < deadline) {
      await sleep(_epsTiming.pollIntervalMs);
      st = await this.readStatus();
    }
    return st;
  }

  /** A status read inside a command flow: one dropped connection mustn't fail the whole
   *  operation, so it's retried like a command. */
  private async readStatus(): Promise<EpsStatus> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= _epsTiming.retryDelaysMs.length; attempt++) {
      if (attempt > 0) await sleep(_epsTiming.retryDelaysMs[attempt - 1]!);
      try {
        return await this.status();
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? new Error(`${this.c.label}: ${lastErr.message}`) : new Error(`${this.c.label}: no status`);
  }

  /** Send a command, then confirm it took by reading the status back. Retries both a lost
   *  connection and a command the unit accepted but didn't apply. */
  private async verified(cmd: string, ok: (s: EpsStatus) => boolean): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= _epsTiming.retryDelaysMs.length; attempt++) {
      if (attempt > 0) await sleep(_epsTiming.retryDelaysMs[attempt - 1]!);
      try {
        await this.command(cmd);
        // give the unit its loop iteration, then check
        for (let k = 0; k < 4; k++) {
          const st = await this.status().catch(() => null);
          if (st && ok(st)) return;
          await sleep(_epsTiming.pollIntervalMs);
        }
        lastErr = new Error(`${cmd} not confirmed by status`);
      } catch (e) {
        lastErr = e;
      }
      this.log.warn({ cmd, attempt, err: lastErr }, "EPS command not confirmed — retrying");
    }
    throw lastErr instanceof Error ? new Error(`${this.c.label}: ${lastErr.message}`) : new Error(`${this.c.label}: ${cmd} failed`);
  }

  async status(): Promise<EpsStatus> {
    const raw = await this.enqueue(() => this.send("POWER_STATUS"));
    const f = parseStatus(raw);
    const st = { system: f.system, state: f.state, outputs: f.outputs, raw };
    this.noteBits(st.outputs);
    return st;
  }

  private command(cmd: string): Promise<string> {
    return this.enqueue(() => this.send(cmd));
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private noteBits(bits: string | undefined): void {
    if (!bits) return;
    const now = Date.now();
    if (this.lastBits) {
      for (let i = 0; i < 6; i++) if (this.lastBits[i] === "1" && bits[i] === "0" && !this.lastOff.has(i + 1)) this.lastOff.set(i + 1, now);
    }
    for (let i = 0; i < 6; i++) if (bits[i] === "1") this.lastOff.delete(i + 1);
    this.lastBits = bits;
  }

  private async refresh(): Promise<void> {
    // A command in flight owns the unit — a poll squeezed in next to it is exactly the
    // collision that makes the hardware drop both. The command refreshes when it's done.
    if (this.pendingCommands > 0) return;
    const raw = await this.enqueue(() => this.send("POWER_STATUS"));
    const f = parseStatus(raw);
    this.noteBits(f.outputs);
    if (this.c.independentOutputs && f.outputs) this.applyOutputBits(f.outputs);
    this.online({
      extra: {
        raw,
        system: f.system ?? null,
        state: f.state ?? null,
        outputs: f.outputs ?? null,
        d5: f.d5 ?? null,
        net: f.net ?? null,
        label: f.label ?? null,
      },
      zones: this.zoneState,
    });
  }

  /** OUTPUTS is 6 bits, left-to-right for Output 1..6; "1" = ON. */
  private applyOutputBits(bits: string): void {
    this.zoneState = this.zoneState.map((z) => {
      const o = (this.c.outputs ?? []).find((x) => x.id === z.id);
      if (!o || o.index < 1 || o.index > bits.length) return z;
      return { ...z, on: bits[o.index - 1] === "1" };
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
