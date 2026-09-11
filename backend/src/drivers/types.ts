import type { DeviceState, DeviceType, ZoneState } from "@excontrol/shared";
import type { DeviceConfig } from "../config.js";
import { bus } from "../core/bus.js";
import { store } from "../core/state.js";
import { log } from "../logger.js";

export interface Driver {
  readonly id: string;
  readonly type: DeviceType;
  /** Open connections, start polling. Must not throw — report status via patch(). */
  start(): Promise<void>;
  stop(): Promise<void>;

  /** Zone-scoped capabilities. Absence => the API returns 400 for that verb. */
  setBrightness?(zoneId: string, pct: number): Promise<void>;
  recallPreset?(zoneId: string, presetId: number): Promise<void>;
  setBlackout?(zoneId: string, on: boolean): Promise<void>;
  /** EPS independent output control: a plain on/off relay zone. */
  setOn?(zoneId: string, on: boolean): Promise<void>;
  /** EPS-style raw actions keyed by name ("power_on" / "power_off" / "status"). */
  action?(name: string): Promise<string>;

  /** Current zone list (from config or discovery). */
  zones(): ZoneState[];
}

export abstract class BaseDriver implements Driver {
  readonly id: string;
  readonly type: DeviceType;
  protected readonly cfg: DeviceConfig;
  protected readonly log;
  private pollTimer?: NodeJS.Timeout;
  protected zoneState: ZoneState[] = [];

  constructor(cfg: DeviceConfig) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.type = cfg.type;
    this.log = log.child({ driver: cfg.type, id: cfg.id });
  }

  abstract start(): Promise<void>;

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  zones(): ZoneState[] {
    return this.zoneState;
  }

  protected patch(p: Partial<DeviceState>): void {
    bus.emit("device:patch", { id: this.id, ...p });
  }

  /** Merge updates into one zone by id, then push the whole zone array up. */
  protected patchZone(zoneId: string, z: Partial<ZoneState>): void {
    this.zoneState = this.zoneState.map((zs) => (zs.id === zoneId ? { ...zs, ...z } : zs));
    this.patch({ zones: this.zoneState });
  }

  protected setZones(zones: ZoneState[]): void {
    this.zoneState = zones;
    this.patch({ zones });
  }

  protected online(extra?: Partial<DeviceState>): void {
    this.patch({ status: "online", lastSeen: Date.now(), error: undefined, ...extra });
  }

  protected offline(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    // An unreachable non-EPS device during power-off / power-on is expected, not a fault.
    const level = store.domainOf(this.id)?.level;
    let status: DeviceState["status"] = "offline";
    if (this.type !== "expromo-eps") {
      if (level === "off") status = "powered-off";
      else if (level === "starting" || level === "unknown") status = "initializing";
    }
    this.patch({ status, error: msg });
  }

  protected initializing(note?: string): void {
    this.patch({ status: "initializing", error: note });
  }

  protected startPolling(fn: () => Promise<void>): void {
    const ms = this.cfg.pollMs ?? 5000;
    const tick = () => void fn().catch((e) => this.offline(e));
    tick();
    this.pollTimer = setInterval(tick, ms);
  }

  protected zoneById(zoneId: string): ZoneState {
    const z = this.zoneState.find((zs) => zs.id === zoneId);
    if (!z) throw new Error(`${this.id}: no zone "${zoneId}"`);
    return z;
  }
}
