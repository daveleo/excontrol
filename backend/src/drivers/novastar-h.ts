import { createHash } from "node:crypto";
import CryptoJS from "crypto-js";
import { BaseDriver } from "./types.js";
import type { HConfig, ZoneConfig } from "../config.js";
import type { Preset, PresetLayer, ZoneCanvas, ZoneState, ProbeResult } from "@excontrol/shared";
import { netReason } from "../setup/neterr.js";

interface RawLayer {
  general?: { zorder?: number };
  source?: { name?: string; inputId?: number };
  window: { x: number; y: number; width: number; height: number };
}

/** ZoneCanvas plus its absolute origin, which layer windows are relative to. Kept on the
 *  zone state too (the extra fields are harmless to the UI). */
type ZoneCanvasAbs = ZoneCanvas & { x0: number; y0: number };

/** The canvas is the bounding box of the screen's output cells. */
function toCanvas(cells?: Array<{ x: number; y: number; width: number; height: number }>): ZoneCanvasAbs | undefined {
  const cs = (cells ?? []).filter((c) => c.width > 0 && c.height > 0);
  if (!cs.length) return undefined;
  const x0 = Math.min(...cs.map((c) => c.x));
  const y0 = Math.min(...cs.map((c) => c.y));
  const width = Math.max(...cs.map((c) => c.x + c.width)) - x0;
  const height = Math.max(...cs.map((c) => c.y + c.height)) - y0;
  return {
    x0, y0, width, height,
    cells: cs.map((c) => ({ x: (c.x - x0) / width, y: (c.y - y0) / height, w: c.width / width, h: c.height / height })),
  };
}

/**
 * NovaStar H series Open API — one driver instance, one or more zones (screens).
 *
 * HTTP POST + JSON to  http://<host>:<port>/open/api<address>
 * Envelope: { body, sign, pId, timeStamp }
 *   unencrypted  sign = base64( md5_hex( timeStamp + pId ) )
 *   encrypted    body = base64(DES-ECB/PKCS7(json), key=secretKey[8]),
 *                sign = base64( md5_hex( cipher + timeStamp + pId + secretKey ) )
 * Response: { status: 0 = ok, msg, body }  (some builds emit "status " with a trailing space)
 *
 * Gotchas baked into the drivers of record:
 *  - the OpenAPI entry "Disable" toggle is inverted (blue = active)
 *  - FTB `Ftb.enable` is inverted: 1 = normal, 0 = blacked out
 *  - status 912 = the device is still booting
 */
export class NovastarHDriver extends BaseDriver {
  private readonly c: HConfig;
  private readonly root: string;
  /** zoneId -> its screen/device numbers */
  private zoneMap = new Map<string, { screenId: number; deviceId: number }>();

  constructor(cfg: HConfig) {
    super(cfg);
    this.c = cfg;
    this.root = `http://${cfg.host}:${cfg.port}/open/api`;
  }

  async start(): Promise<void> {
    this.patch({ status: "connecting" });
    this.startPolling(async () => {
      try {
        await this.ensureZones();
        for (const z of this.zoneState) {
          const m = this.zoneMap.get(z.id)!;
          const [detail, presets] = await Promise.all([
            this.readDetail(m.screenId, m.deviceId),
            this.readPresets(m.screenId, m.deviceId),
          ]);
          const canvas = detail.canvas ?? (z.canvas as ZoneCanvasAbs | undefined);
          const withLayers = await this.attachLayouts(m.screenId, m.deviceId, presets, canvas);
          this.patchZone(z.id, { brightness: detail.brightness, blackout: detail.blackout, presets: withLayers, canvas });
        }
        this.online();
      } catch (e) {
        if (e instanceof Error && /status 912\b/.test(e.message)) this.initializing("still starting up");
        else throw e;
      }
    });
  }

  /** One-shot connection test for the setup wizard. Never polls. */
  static async probe(cfg: HConfig): Promise<ProbeResult> {
    return new NovastarHDriver(cfg).probeOnce();
  }

  private async probeOnce(): Promise<ProbeResult> {
    const hp = `${this.c.host}:${this.c.port}`;
    try {
      const body = await this.call<{ screens?: Array<{ screenId: number; name?: string }> }>(
        "/screen/readList",
        { deviceId: 0 },
      );
      const screens = body?.screens ?? [];
      return {
        ok: true,
        hint: "ok",
        detail: screens.length
          ? `Connected — found ${screens.length} screen${screens.length === 1 ? "" : "s"}.`
          : "Connected, but no screens are defined on the controller yet.",
        zones: screens.map((s) => ({
          id: `s${s.screenId}`,
          label: (s.name || "").trim() || `Screen ${s.screenId}`,
          screenId: s.screenId,
        })),
      };
    } catch (e) {
      const net = netReason(e, hp);
      if (net) return { ok: false, ...net };
      const msg = e instanceof Error ? e.message : String(e);
      if (/status 15\b/.test(msg))
        return { ok: false, hint: "disabled", detail: 'The controller rejected this OpenAPI entry ("Open_Id_Illegal"). In the controller\'s OpenAPI settings, check the Project ID and make sure this entry\'s Disable toggle is BLUE (enabled).' };
      if (/status 13\b/.test(msg))
        return { ok: false, hint: "misconfigured", detail: 'The OpenAPI project is not fully set up on the controller ("Open_Project_Illegal") — finish configuring the entry.' };
      if (/status 912\b/.test(msg))
        return { ok: false, hint: "booting", detail: "The controller is still starting up. Wait a minute and test again." };
      if (/HTTP 5\d\d\b|Server_Err/.test(msg))
        return { ok: false, hint: "auth", detail: "The controller returned a server error — usually a wrong Secret Key, or the Encryption checkbox not matching the controller." };
      return { ok: false, hint: "bad-response", detail: `Unexpected response from the controller: ${msg}` };
    }
  }

  async setBrightness(zoneId: string, pct: number): Promise<void> {
    const m = this.zoneMap.get(zoneId);
    if (!m) throw new Error(`${this.id}: no zone "${zoneId}"`);
    const brightness = Math.max(0, Math.min(100, Math.round(pct)));
    await this.call("/screen/writeBrightness", { screenId: m.screenId, deviceId: m.deviceId, brightness });
    this.patchZone(zoneId, { brightness });
  }

  async recallPreset(zoneId: string, presetId: number): Promise<void> {
    const m = this.zoneMap.get(zoneId);
    if (!m) throw new Error(`${this.id}: no zone "${zoneId}"`);
    await this.call("/preset/play", { screenId: m.screenId, deviceId: m.deviceId, presetId });
    this.patchZone(zoneId, { activePreset: presetId });
  }

  async setBlackout(zoneId: string, on: boolean): Promise<void> {
    const m = this.zoneMap.get(zoneId);
    if (!m) throw new Error(`${this.id}: no zone "${zoneId}"`);
    // type 0 = black screen, type 1 = bright (normal)
    await this.call("/screen/ftb", { screenId: m.screenId, deviceId: m.deviceId, type: on ? 0 : 1, time: 0 });
    this.patchZone(zoneId, { blackout: on });
  }

  /** Build the zone list from config, or discover it once. */
  private async ensureZones(): Promise<void> {
    if (this.zoneMap.size) return;

    let zoneCfgs: ZoneConfig[] = this.c.zones ?? [];
    if (!zoneCfgs.length) {
      const body = await this.call<{ screens?: Array<{ screenId: number; name?: string }> }>(
        "/screen/readList",
        { deviceId: 0 },
      );
      zoneCfgs = (body?.screens ?? []).map((s) => ({
        id: `s${s.screenId}`,
        label: (s.name || "").trim() || `Screen ${s.screenId}`,
        screenId: s.screenId,
      }));
      if (!zoneCfgs.length) throw new Error("H-series: no screens found");
      this.log.info({ zones: zoneCfgs }, "discovered screens");
    }

    const zones: ZoneState[] = [];
    for (const z of zoneCfgs) {
      const screenId = typeof z.screenId === "number" ? z.screenId : Number(z.screenId) || 0;
      this.zoneMap.set(z.id, { screenId, deviceId: z.deviceId ?? 0 });
      zones.push({ id: z.id, label: z.label });
    }
    this.setZones(zones);
  }

  private async readDetail(screenId: number, deviceId: number): Promise<{ brightness?: number; blackout?: boolean; canvas?: ZoneCanvasAbs }> {
    const body = await this.call<{
      brightness?: number;
      Ftb?: { enable?: number };
      outputMode?: { screenInterfaces?: Array<{ x: number; y: number; width: number; height: number }> };
    }>("/screen/readDetail", { deviceId, screenId });
    return {
      brightness: typeof body?.brightness === "number" ? body.brightness : undefined,
      blackout: body?.Ftb ? body.Ftb.enable === 0 : undefined,
      canvas: toCanvas(body?.outputMode?.screenInterfaces),
    };
  }

  /* ---- preset layouts (thumbnails) ----
   * /preset/readDetail returns each layer's window in the same absolute coordinates as the
   * screen's output cells (both offset, typically at 1000,1000). Details change only when
   * someone edits a preset, so they're cached and re-read once a minute, not every poll. */

  private layoutCache = new Map<string, { at: number; layers: RawLayer[] }>();
  private signals = new Map<number, boolean>();
  private signalsAt = 0;

  private async attachLayouts(screenId: number, deviceId: number, presets: Preset[], canvas?: ZoneCanvasAbs): Promise<Preset[]> {
    if (!canvas) return presets;
    const now = Date.now();
    if (now - this.signalsAt > 10_000) {
      this.signalsAt = now;
      await this.readSignals().catch((e) => this.log.debug({ err: e }, "input list read failed"));
    }
    for (const p of presets) {
      const key = `${deviceId}:${screenId}:${p.id}`;
      const hit = this.layoutCache.get(key);
      if (hit && now - hit.at < 60_000) continue;
      try {
        const d = await this.call<{ layers?: RawLayer[] }>("/preset/readDetail", { deviceId, screenId, presetId: p.id });
        this.layoutCache.set(key, { at: now, layers: d?.layers ?? [] });
      } catch (e) {
        this.log.debug({ err: e, presetId: p.id }, "preset detail read failed");
      }
    }
    return presets.map((p) => {
      const raw = this.layoutCache.get(`${deviceId}:${screenId}:${p.id}`)?.layers;
      if (!raw) return p;
      const layers: PresetLayer[] = raw
        .filter((l) => l.window && l.window.width > 0 && l.window.height > 0)
        .map((l) => ({
          x: (l.window.x - canvas.x0) / canvas.width,
          y: (l.window.y - canvas.y0) / canvas.height,
          w: l.window.width / canvas.width,
          h: l.window.height / canvas.height,
          z: l.general?.zorder ?? 0,
          source: (l.source?.name || "").trim() || "Layer",
          signal: l.source?.inputId != null ? this.signals.get(l.source.inputId) : undefined,
        }))
        .sort((a, b) => a.z - b.z);
      return { ...p, layers };
    });
  }

  private async readSignals(): Promise<void> {
    const body = await this.call<{ inputs?: Array<{ inputId: number; resolution?: { width?: number } }> }>("/input/readList", { deviceId: 0 });
    this.signals = new Map((body?.inputs ?? []).map((i) => [i.inputId, (i.resolution?.width ?? 0) > 0]));
  }

  private async readPresets(screenId: number, deviceId: number): Promise<Preset[]> {
    const body = await this.call<{ presets?: Array<{ presetId: number; name: string }> }>(
      "/preset/readList",
      { deviceId, screenId },
    );
    return (body?.presets ?? []).map((p) => ({ id: p.presetId, name: (p.name || "").trim() || `Preset ${p.presetId}` }));
  }

  /* ---- transport ---- */

  private md5b64(s: string): string {
    return Buffer.from(createHash("md5").update(s, "utf8").digest("hex"), "utf8").toString("base64");
  }
  private desKey() {
    if (Buffer.from(this.c.secretKey, "utf8").length !== 8) {
      throw new Error(`H-series secretKey must be 8 bytes for DES (got ${this.c.secretKey.length})`);
    }
    return CryptoJS.enc.Utf8.parse(this.c.secretKey);
  }
  private encryptBody(plain: string): string {
    return CryptoJS.DES.encrypt(plain, this.desKey(), { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 }).toString();
  }
  private decryptBody(cipherB64: string): string {
    return CryptoJS.DES.decrypt(cipherB64, this.desKey(), { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 }).toString(
      CryptoJS.enc.Utf8,
    );
  }

  private async call<T = unknown>(address: string, body: Record<string, unknown>): Promise<T> {
    const timeStamp = String(Date.now());
    const { pId, secretKey, encrypted } = this.c;

    let payloadBody: unknown;
    let sign: string;
    if (encrypted) {
      const ct = this.encryptBody(JSON.stringify(body));
      payloadBody = ct;
      sign = this.md5b64(ct + timeStamp + pId + secretKey);
    } else {
      payloadBody = body;
      sign = this.md5b64(timeStamp + pId);
    }

    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 6000);
    let res: Response;
    try {
      res = await fetch(this.root + address, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: payloadBody, sign, pId, timeStamp }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(to);
    }
    if (!res.ok) throw new Error(`H-series ${address} HTTP ${res.status}`);

    const json = (await res.json()) as Record<string, unknown>;
    const status = Number(json["status"] ?? json["status "] ?? -1);
    if (status !== 0) throw new Error(`H-series ${address} status ${status}: ${String(json["msg"] ?? "")}`);

    let out = json["body"] ?? json["data"] ?? {};
    if (encrypted && typeof out === "string" && out.length > 0) out = JSON.parse(this.decryptBody(out));
    return out as T;
  }
}
