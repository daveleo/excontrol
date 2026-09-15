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
 * "Power on/off" (0xC003, data 0x5E on / 0x5F sleep) is a quick, reversible video-mute the
 * device answers everything else through — this is what's exposed as this zone's on/off,
 * matching what a day-to-day "screen on/off" button should do. The protocol also has a
 * separate deep Standby/Restart (0xC007/0xC009) that reboots the unit into a restricted
 * state answering almost nothing for ~25s; deliberately not exposed here.
 */

const CODE = {
  QUERY_SCREEN_STATUS: "C005", // -> C006, data[0]: 0x80 awake, 0x00 asleep
  SET_POWER: "C003", // -> C004, data[0] echoes what was sent (0x5E on / 0x5F sleep) — not a status word
  QUERY_VOLUME: "C201", // -> C202, data[0] 0-100
  SET_VOLUME: "C203", // -> C204 ack(status)
  QUERY_BRIGHTNESS: "C21D", // -> C21E, data[0] 0-100
  SET_BRIGHTNESS: "C21F", // -> C220 ack(status)
  QUERY_SOURCE: "C211", // -> C212, data[0] source byte
  SET_SOURCE: "C213", // -> C214 ack(status)
  HDMI_SIGNAL: "C25B", // -> C25C, data[0..3]: HDMI1-4 signal present (0x01) / not (0x00)
} as const;

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
 *  silently returning nonsense — a garbled/short reply becomes a failed poll, not bad state. */
function parseReply(buf: Buffer): ParsedReply {
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

export class ExviewDriver extends BaseDriver {
  private readonly c: ExviewConfig;

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

  private async poll(): Promise<void> {
    const [statusReply, volReply, brightReply, srcReply, hdmiReply] = await Promise.all([
      this.send(CODE.QUERY_SCREEN_STATUS, []),
      this.send(CODE.QUERY_VOLUME, []),
      this.send(CODE.QUERY_BRIGHTNESS, []),
      this.send(CODE.QUERY_SOURCE, []),
      this.send(CODE.HDMI_SIGNAL, []),
    ]);
    const on = statusReply.data[0] === 0x80;
    this.patchZone(ZONE, {
      on,
      volume: volReply.data[0],
      brightness: brightReply.data[0],
      activePreset: srcReply.data[0],
      presets: this.presetsWithSignal(hdmiReply.data),
    });
    this.online();
  }

  async setOn(zoneId: string, on: boolean): Promise<void> {
    // Unlike every other Set command here, C004's ack echoes the sent byte back (1 byte),
    // not a 2-byte success/failure status word — confirmed against real hardware, where
    // treating it as a status word (ackOk) made every real power command look rejected.
    const want = on ? 0x5e : 0x5f;
    const reply = await this.send(CODE.SET_POWER, [want]);
    if (reply.data[0] !== want) throw new Error("eXview: power command not confirmed");
    this.patchZone(zoneId, { on });
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
      const reply = await this.send(CODE.QUERY_SCREEN_STATUS, []);
      const awake = reply.data[0] === 0x80;
      return {
        ok: true,
        hint: "ok",
        detail: `Connected to the eXview ${this.c.model === "aio" ? "AIO" : "Edge"}.`,
        info: awake ? "screen on" : "screen off",
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
    const frame = buildFrame(setCode, dataBytes);
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
      const timer = setTimeout(() => finish(() => reject(new Error(`eXview timeout waiting for ${setCode}`))), timeoutMs);
      sock.on("error", (e) => finish(() => reject(e)));
      sock.on("message", (msg) => {
        finish(() => {
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
