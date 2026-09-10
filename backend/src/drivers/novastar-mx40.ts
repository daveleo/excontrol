import { BaseDriver } from "./types.js";
import type { CoexConfig, ZoneConfig } from "../config.js";
import type { Preset, ZoneState } from "@excontrol/shared";

/**
 * NovaStar COEX controllers (MX40 Pro / CX / MX6000 …). HTTP only, port 8001, no auth.
 * Response wrapper: { code, data, message } — code 0 (or 200) == success; empty body == ok.
 * One driver instance, one or more zones (screens).
 *
 * Gotcha: blackout needs the real canvas IDs (e.g. 2048). `[0]` silently no-ops.
 */
interface CoexScreen {
  screenID: string;
  screenName?: string;
  canvases?: Array<{ canvasID: number }>;
}

export class NovastarCoexDriver extends BaseDriver {
  private readonly c: CoexConfig;
  private readonly base: string;
  /** zoneId -> { screenID (GUID), canvasIds } */
  private zoneMap = new Map<string, { screenID: string; canvasIds: number[] }>();

  constructor(cfg: CoexConfig) {
    super(cfg);
    this.c = cfg;
    this.base = `http://${cfg.host}:${cfg.port}`;
  }

  async start(): Promise<void> {
    this.patch({ status: "connecting" });
    this.startPolling(async () => {
      await this.ensureZones();
      const [params, presets, display] = await Promise.all([
        this.call<{ list?: Array<{ screenId: string; brightness?: number }> }>("GET", "/api/v1/screen/displayparams"),
        this.call<{ screenPresets?: Array<{ screenID: string; presets?: Array<{ sequenceNumber: number; name: string }> }> }>(
          "GET",
          "/api/v1/preset",
        ),
        this.call<{ displayState?: Array<{ canvasID?: number; displayMode?: number }> }>(
          "GET",
          "/api/v1/screen/output/display/state",
        ),
      ]);

      for (const z of this.zoneState) {
        const m = this.zoneMap.get(z.id)!;
        const brightRow = params?.list?.find((r) => r.screenId === m.screenID);
        const presetRow = presets?.screenPresets?.find((r) => r.screenID === m.screenID);
        const dispRow = display?.displayState?.find((r) => m.canvasIds.includes(r.canvasID ?? -1));
        this.patchZone(z.id, {
          brightness: typeof brightRow?.brightness === "number" ? Math.round(brightRow.brightness * 100) : undefined,
          presets: (presetRow?.presets ?? []).map((p): Preset => ({
            id: p.sequenceNumber,
            name: (p.name || "").trim() || `Preset ${p.sequenceNumber}`,
          })),
          blackout: typeof dispRow?.displayMode === "number" ? dispRow.displayMode === 1 : undefined,
        });
      }
      this.online();
    });
  }

  async setBrightness(zoneId: string, pct: number): Promise<void> {
    const m = this.map(zoneId);
    const ratio = Math.max(0, Math.min(1, pct / 100));
    await this.call("PUT", "/api/v1/screen/brightness", { screenIdList: [m.screenID], brightness: ratio });
    this.patchZone(zoneId, { brightness: Math.round(ratio * 100) });
  }

  async recallPreset(zoneId: string, sequenceNumber: number): Promise<void> {
    const m = this.map(zoneId);
    await this.call("POST", "/api/v1/preset/current/update", { sequenceNumber, screenID: m.screenID });
    this.patchZone(zoneId, { activePreset: sequenceNumber });
  }

  async setBlackout(zoneId: string, on: boolean): Promise<void> {
    const m = this.map(zoneId);
    if (!m.canvasIds.length) throw new Error(`${this.id}: no canvas ids for zone "${zoneId}"`);
    await this.call("PUT", "/api/v1/device/displaymode", { value: on ? 1 : 0, canvasIDs: m.canvasIds });
    this.patchZone(zoneId, { blackout: on });
  }

  private map(zoneId: string) {
    const m = this.zoneMap.get(zoneId);
    if (!m) throw new Error(`${this.id}: no zone "${zoneId}"`);
    return m;
  }

  private async ensureZones(): Promise<void> {
    if (this.zoneMap.size) return;
    const data = await this.call<{ screens?: CoexScreen[] }>("GET", "/api/v1/screen?isNeedCabinetInfo=1");
    const screens = data?.screens ?? [];
    if (!screens.length) throw new Error("COEX: no screens returned from /api/v1/screen");

    let zoneCfgs: ZoneConfig[] = this.c.zones ?? [];
    if (!zoneCfgs.length) {
      zoneCfgs = screens.map((s, i) => ({
        id: `s${i}`,
        label: (s.screenName || "").trim() || `Screen ${i + 1}`,
        screenId: s.screenID,
      }));
      this.log.info({ zones: zoneCfgs }, "discovered COEX screens");
    }

    const zones: ZoneState[] = [];
    for (const z of zoneCfgs) {
      const screenID = String(z.screenId);
      const screen = screens.find((s) => s.screenID === screenID) ?? screens[0];
      const canvasIds = (screen?.canvases ?? []).map((c) => c.canvasID).filter((n) => typeof n === "number");
      this.zoneMap.set(z.id, { screenID: screen?.screenID ?? screenID, canvasIds });
      zones.push({ id: z.id, label: z.label });
    }
    this.setZones(zones);
  }

  private async call<T = unknown>(method: "GET" | "PUT" | "POST", path: string, body?: unknown): Promise<T> {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 6000);
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(to);
    }
    if (!res.ok) throw new Error(`COEX ${method} ${path} HTTP ${res.status}`);
    const text = (await res.text()).trim();
    const json = (text ? JSON.parse(text) : { code: 0 }) as { code?: number; data?: unknown; message?: string };
    const code = Number(json.code ?? 0);
    if (code !== 0 && code !== 200) throw new Error(`COEX ${method} ${path} code ${code}: ${json.message ?? ""}`);
    return (json.data ?? {}) as T;
  }
}
