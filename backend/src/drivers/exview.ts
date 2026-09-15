import { createSocket } from "node:dgram";
import { BaseDriver } from "./types.js";
import type { ExviewConfig } from "../config.js";
import type { Preset, ProbeResult } from "@excontrol/shared";
import { netReason } from "../setup/neterr.js";

/**
 * Expromo eXview Edge/AIO — UDP control protocol, port 8600. Frame shape (validated against
 * the full command reference — see exview-aio-driver-wiki on GitHub):
 *
 *   55 55 55 55 55 55 55  C0 01 03 <dir>  D0 00 D1 <codeLo> <codeHi>  00 00  FF*17
 *   00 <dataLen> 00  <data bytes>  <checksum>
 *
 * `<dir>` is 0x01 for a request (set/query) and 0x00 for the device's reply — on a reply,
 * the D0/D1 marker pair swaps order (D1 01 D0 <codeLo> <codeHi> ...) but the rest of the
 * template is identical. Checksum = sum of bytes[8 .. end-1] & 0xFF (verified against every
 * example in the reference — no special-case formula needed).
 *
 * The device has no unsolicited/push feedback — everything here is poll-driven, same as
 * every other driver in this codebase.
 *
 * Video source byte values (shared by Set/Query video source): 0x00 Android, 0x01 Windows,
 * 0x02 HDMI1, 0x03 HDMI2, 0x04 HDMI3, 0x06 HDMI4 — note 0x05 is skipped entirely, not a typo.
 * Only Android + the model's HDMI inputs are exposed as presets here (not Windows — the
 * eXview line doesn't run one). HDMI signal-presence (0xC25B) is polled alongside everything
 * else and merged onto each HDMI preset as `hasSignal`, independent of which is selected —
 * mirrors the Crestron module's per-input `Active_Fb` outputs.
 *
 * ---- Three real power states, not two (see docs/ROADMAP.md Phase 11 for the full story) ----
 *
 * "Power off" (0xC003, data 0x5F) is an immediate, reversible video-mute ("Blackout") — the
 * device stays fully responsive. But a prolonged Blackout auto-transitions into a deep,
 * restricted "Standby" on its own (the timeout is a setting on the device itself, e.g. 5
 * minutes — invisible to this app until it happens); the same restricted state is also
 * reachable directly via 0xC007. In that restricted state the unit reboots its LED relays
 * and its own "sending card," which comes back up in a low-power mode that only accepts one
 * thing: the special wake packet below — every other command, including the plain 0xC003
 * wake byte, gets rejected.
 *
 * Distinguishing Blackout from Standby needs two queries, not one, and getting this wrong is
 * an easy trap — a real bug in an earlier internal tool (see exview-control's
 * PROJECT_SNAPSHOT.md) short-circuited to "Eco Standby" the moment 0xC020 reported true,
 * without checking whether 0xC005 also stopped answering normally. The correct resolution,
 * used here:
 *
 *   1. Query 0xC020 ("true/fake standby query") and 0xC005 ("sleep/wake query") together.
 *   2. Either one coming back as the literal ASCII reply "Unsupported protocol" (not a
 *      normal framed reply at all) => Standby (the "Active Standby" variant — restricted,
 *      but 0xC020 and the wake packet still work).
 *   3. 0xC005 timing out entirely *and* 0xC020 == 1 => Standby (the "Eco Standby" variant —
 *      even 0xC020 style probes may go unanswered depending on firmware, but this app only
 *      needs to tell "on/blackout" from "standby", not tell the two standby flavors apart).
 *   4. 0xC005 == 0x80 => On. 0xC005 == 0x00 => Blackout.
 *   5. Anything else (e.g. both time out) => Unknown — don't guess.
 *
 * Volume/brightness/source/HDMI-signal are only queried when state is On or Blackout — in
 * Standby they'd also just come back "Unsupported protocol", so there's nothing to read.
 *
 * Waking from Standby needs the dedicated 10-byte wake packet (`AA BB CC 01 00 00 01 DD EE
 * FF`, no sync preamble, not a normal framed command, no reply) — the plain 0xC003 wake byte
 * is exactly the "everything else" that gets rejected while restricted. Confirmed against
 * real hardware: full recovery is a two-reboot affair, roughly 70s wall-clock from a direct
 * 0xC007 to fully "On" again.
 */

const CODE = {
  QUERY_SCREEN_STATUS: "C005", // -> C006, data[0]: 0x80 awake, 0x00 blackout
  QUERY_TRUE_STANDBY: "C020", // -> C021, data[0]: 1 often means Standby, but see resolvePowerState — not trustworthy alone
  SET_POWER: "C003", // -> C004, data[0] echoes what was sent (0x5E on / 0x5F blackout) — not a status word
  QUERY_VOLUME: "C201", // -> C202, data[0] 0-100
  SET_VOLUME: "C203", // -> C204 ack(status)
  QUERY_BRIGHTNESS: "C21D", // -> C21E, data[0] 0-100
  SET_BRIGHTNESS: "C21F", // -> C220 ack(status)
  QUERY_SOURCE: "C211", // -> C212, data[0] source byte
  SET_SOURCE: "C213", // -> C214 ack(status)
  HDMI_SIGNAL: "C25B", // -> C25C, data[0..3]: HDMI1-4 signal present (0x01) / not (0x00)
} as const;

/** Not a framed reply at all — just this literal ASCII text — sent for almost anything while
 *  the device is in (either flavor of) Standby. */
const UNSUPPORTED_PROTOCOL_TEXT = "Unsupported protocol";
/** Sentinel `ParsedReply.code` used for the text above, so callers can check it like any
 *  other reply code instead of every call site needing its own string search. */
const UNSUPPORTED_PROTOCOL_CODE = "UNSUPPORTED";

/** The only thing a Standby-restricted unit accepts. Raw bytes, no sync preamble, no
 *  checksum, no reply — confirmed against real hardware. */
const WAKE_PACKET = Buffer.from([0xaa, 0xbb, 0xcc, 0x01, 0x00, 0x00, 0x01, 0xdd, 0xee, 0xff]);

const ANDROID_SOURCE: Preset = { id: 0x00, name: "Android" };
/** id -> name for the HDMI inputs; only HDMI1/2 for Edge, HDMI1-4 for AIO. Android (above)
 *  is always offered regardless of model — it's the unit's built-in OS, not a cable input. */
const HDMI_SOURCES: Preset[] = [
  { id: 0x02, name: "HDMI 1" },
  { id: 0x03, name: "HDMI 2" },
  { id: 0x04, name: "HDMI 3" },
  { id: 0x06, name: "HDMI 4" },
];

const ZONE = "screen";

function buildFrame(setCode: string, dataBytes: number[]): Buffer {
  const codeHigh = parseInt(setCode.slice(0, 2), 16);
  const codeLow = parseInt(setCode.slice(2, 4), 16);
  const bytes = [
    0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55,
    0xc0, 0x01, 0x03, 0x01, // request direction
    0xd0, 0x00, 0xd1, codeLow, codeHigh,
    0x00, 0x00,
    ...Array(17).fill(0xff),
    0x00, dataBytes.length, 0x00,
    ...dataBytes,
  ];
  const checksum = bytes.slice(8).reduce((a, b) => a + b, 0) & 0xff;
  bytes.push(checksum);
  return Buffer.from(bytes);
}

interface ParsedReply {
  code: string;
  data: number[];
}

/** Parse + validate a reply frame. Throws on anything that doesn't look right, rather than
 *  silently returning nonsense — a garbled/short reply becomes a failed poll, not bad state.
 *  The one deliberate exception: the plain-text "Unsupported protocol" reply a Standby unit
 *  sends for almost everything isn't a framed reply at all, so it's recognized up front
 *  rather than falling through to (and failing) the framed-reply checks below. */
function parseReply(buf: Buffer): ParsedReply {
  if (buf.includes(UNSUPPORTED_PROTOCOL_TEXT, 0, "latin1")) return { code: UNSUPPORTED_PROTOCOL_CODE, data: [] };
  if (buf.length < 39) throw new Error(`eXview: reply too short (${buf.length} bytes)`);
  for (let i = 0; i < 7; i++) if (buf[i] !== 0x55) throw new Error("eXview: bad sync bytes");
  if (buf[11] !== 0xd1 || buf[13] !== 0xd0) throw new Error("eXview: unexpected reply header");
  const codeLow = buf[14]!;
  const codeHigh = buf[15]!;
  const code = (codeHigh.toString(16).padStart(2, "0") + codeLow.toString(16).padStart(2, "0")).toUpperCase();
  const len = buf[36]!;
  if (buf.length < 38 + len + 1) throw new Error("eXview: reply shorter than its own length field");
  const data = [...buf.subarray(38, 38 + len)];
  const checksum = buf[buf.length - 1]!;
  const computed = buf.subarray(8, buf.length - 1).reduce((a, b) => a + b, 0) & 0xff;
  if (checksum !== computed) throw new Error("eXview: checksum mismatch");
  return { code, data };
}

/** Ack status word (little-endian in the 2-byte reply payload); 0x0001 = success. */
function ackOk(data: number[]): boolean {
  return data.length >= 2 && (data[0]! | (data[1]! << 8)) === 1;
}

type PowerState = "on" | "blackout" | "standby" | "unknown";

export class ExviewDriver extends BaseDriver {
  private readonly c: ExviewConfig;
  /** Updated on every poll; consulted by setOn() to pick the right wake mechanism — the
   *  plain wake byte only works from Blackout, Standby needs the dedicated wake packet. */
  private lastPowerState: PowerState = "unknown";

  constructor(cfg: ExviewConfig) {
    super(cfg);
    this.c = cfg;
    this.zoneState = [{ id: ZONE, label: "Screen", presets: this.presetList() }];
  }

  private presetList(): Preset[] {
    const count = this.c.model === "aio" ? 4 : 2;
    return [ANDROID_SOURCE, ...HDMI_SOURCES.slice(0, count)];
  }

  /** Same list, with each HDMI entry's live signal-presence merged in. Android has no
   *  "signal" concept in this protocol (it's not a cable input) — left unset for it. */
  private presetsWithSignal(hdmiSignalBits: number[]): Preset[] {
    return this.presetList().map((p) => {
      const hdmiIndex = HDMI_SOURCES.findIndex((h) => h.id === p.id);
      if (hdmiIndex < 0) return p;
      return { ...p, hasSignal: hdmiSignalBits[hdmiIndex] === 1 };
    });
  }

  async start(): Promise<void> {
    this.patch({ status: "connecting" });
    this.startPolling(() => this.poll());
  }

  /** See this file's header comment for the full derivation. Queries 0xC020 and 0xC005
   *  together and combines them — neither alone can reliably tell Blackout from Standby. */
  private async resolvePowerState(): Promise<{ state: PowerState; sleepWake?: ParsedReply }> {
    const [standbySettled, sleepWakeSettled] = await Promise.allSettled([
      this.send(CODE.QUERY_TRUE_STANDBY, []),
      this.send(CODE.QUERY_SCREEN_STATUS, []),
    ]);
    const standby = standbySettled.status === "fulfilled" ? standbySettled.value : null;
    const sleepWake = sleepWakeSettled.status === "fulfilled" ? sleepWakeSettled.value : null;

    // Neither probe got any reply at all — genuinely unreachable, not a power state to
    // report. Throw so the usual startPolling -> offline() path handles it like every other
    // driver's connectivity failure, rather than this becoming a fourth silent "unknown".
    if (standby == null && sleepWake == null) throw new Error("eXview: no reply to either power-state probe");

    const isUnsupported = (r: ParsedReply | null) => r?.code === UNSUPPORTED_PROTOCOL_CODE;
    if (isUnsupported(standby) || isUnsupported(sleepWake)) return { state: "standby" };
    if (sleepWake == null && standby?.data[0] === 1) return { state: "standby" };
    if (sleepWake?.data[0] === 0x80) return { state: "on", sleepWake };
    if (sleepWake?.data[0] === 0x00) return { state: "blackout", sleepWake };
    return { state: "unknown" }; // got a reply, but not one that maps to anything known
  }

  private async poll(): Promise<void> {
    const { state } = await this.resolvePowerState();
    this.lastPowerState = state;

    if (state === "standby" || state === "unknown") {
      // Nothing else is worth asking — Standby answers every other query with the same
      // "Unsupported protocol" text, and a genuinely Unknown state means we can't trust a
      // fresh read either way. Keep whatever brightness/volume/source were last known
      // (BaseDriver/Store already do this across a real disconnect) rather than blanking them.
      this.patchZone(ZONE, { on: false, powerState: state === "standby" ? "standby" : undefined });
      this.online();
      return;
    }

    const [volReply, brightReply, srcReply, hdmiReply] = await Promise.all([
      this.send(CODE.QUERY_VOLUME, []),
      this.send(CODE.QUERY_BRIGHTNESS, []),
      this.send(CODE.QUERY_SOURCE, []),
      this.send(CODE.HDMI_SIGNAL, []),
    ]);
    this.patchZone(ZONE, {
      on: state === "on",
      powerState: state,
      volume: volReply.data[0],
      brightness: brightReply.data[0],
      activePreset: srcReply.data[0],
      presets: this.presetsWithSignal(hdmiReply.data),
    });
    this.online();
  }

  async setOn(zoneId: string, on: boolean): Promise<void> {
    if (!on) {
      // Blackout — the quick, reversible mute. (There's no app-facing way to command deep
      // Standby directly; the device gets there on its own after a prolonged Blackout.)
      const reply = await this.send(CODE.SET_POWER, [0x5f]);
      if (reply.data[0] !== 0x5f) throw new Error("eXview: power command not confirmed");
      this.patchZone(zoneId, { on: false, powerState: "blackout" });
      this.lastPowerState = "blackout";
      return;
    }

    if (this.lastPowerState === "standby" || this.lastPowerState === "unknown") {
      // A Standby-restricted unit rejects the plain wake byte along with everything else —
      // only the dedicated wake packet works, and it sends no reply. Recovery is a two-reboot
      // affair (~70s), so this can't confirm success synchronously; the next poll(s) will
      // pick up the real state once the unit comes back.
      await this.sendRaw(WAKE_PACKET);
      return;
    }

    const reply = await this.send(CODE.SET_POWER, [0x5e]);
    if (reply.data[0] !== 0x5e) throw new Error("eXview: power command not confirmed");
    this.patchZone(zoneId, { on: true, powerState: "on" });
    this.lastPowerState = "on";
  }

  async setBrightness(zoneId: string, pct: number): Promise<void> {
    const v = Math.max(0, Math.min(100, Math.round(pct)));
    const reply = await this.send(CODE.SET_BRIGHTNESS, [v]);
    if (!ackOk(reply.data)) throw new Error("eXview: brightness command rejected");
    this.patchZone(zoneId, { brightness: v });
  }

  async setVolume(zoneId: string, pct: number): Promise<void> {
    const v = Math.max(0, Math.min(100, Math.round(pct)));
    const reply = await this.send(CODE.SET_VOLUME, [v]);
    if (!ackOk(reply.data)) throw new Error("eXview: volume command rejected");
    this.patchZone(zoneId, { volume: v });
  }

  async recallPreset(zoneId: string, presetId: number): Promise<void> {
    if (!this.presetList().some((p) => p.id === presetId)) throw new Error(`eXview: no such input (${presetId})`);
    const reply = await this.send(CODE.SET_SOURCE, [presetId]);
    if (!ackOk(reply.data)) throw new Error("eXview: source switch rejected");
    this.patchZone(zoneId, { activePreset: presetId });
  }

  /** One-shot connection test for the setup wizard. Never polls. */
  static async probe(cfg: ExviewConfig): Promise<ProbeResult> {
    return new ExviewDriver(cfg).probeOnce();
  }

  private async probeOnce(): Promise<ProbeResult> {
    const hp = `${this.c.host}:${this.c.port}`;
    try {
      const { state } = await this.resolvePowerState();
      if (state === "unknown") return { ok: false, hint: "unreachable", detail: `No usable reply from ${hp}.` };
      const label = state === "on" ? "on" : state === "blackout" ? "blacked out" : "in standby";
      return {
        ok: true,
        hint: "ok",
        detail: `Connected to the eXview ${this.c.model === "aio" ? "AIO" : "Edge"}.`,
        info: `screen ${label}`,
      };
    } catch (e) {
      const net = netReason(e, hp);
      if (net) return { ok: false, ...net };
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, hint: "bad-response", detail: `${hp} answered, but not like an eXview unit (${msg}).` };
    }
  }

  /** Send one frame, wait for the matching reply. One UDP socket per command — simple,
   *  and this protocol has no persistent-connection concept to keep alive anyway. */
  private send(setCode: string, dataBytes: number[], timeoutMs = 3000): Promise<ParsedReply> {
    return this.sendAndMaybeWait(buildFrame(setCode, dataBytes), timeoutMs, true) as Promise<ParsedReply>;
  }

  /** Fire a raw buffer with no expectation of a reply (the Standby wake packet). Still
   *  briefly listens in case one arrives, but resolves either way once sent. */
  private sendRaw(frame: Buffer): Promise<void> {
    return this.sendAndMaybeWait(frame, 500, false) as Promise<void>;
  }

  private sendAndMaybeWait(frame: Buffer, timeoutMs: number, expectReply: true): Promise<ParsedReply>;
  private sendAndMaybeWait(frame: Buffer, timeoutMs: number, expectReply: false): Promise<void>;
  private sendAndMaybeWait(frame: Buffer, timeoutMs: number, expectReply: boolean): Promise<ParsedReply | void> {
    return new Promise((resolve, reject) => {
      const sock = createSocket("udp4");
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.removeAllListeners();
        sock.close();
        fn();
      };
      const timer = setTimeout(
        () => finish(() => (expectReply ? reject(new Error("eXview: timeout waiting for reply")) : resolve())),
        timeoutMs,
      );
      sock.on("error", (e) => finish(() => reject(e)));
      sock.on("message", (msg) => {
        finish(() => {
          if (!expectReply) return resolve();
          try {
            resolve(parseReply(msg));
          } catch (e) {
            reject(e);
          }
        });
      });
      sock.send(frame, this.c.port, this.c.host, (err) => {
        if (err) finish(() => reject(err));
      });
    });
  }
}
