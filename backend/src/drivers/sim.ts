import type { ZoneState } from "@excontrol/shared";
import type { DeviceConfig } from "../config.js";
import { store } from "../core/state.js";
import { getCachedZones, getCachedExtra } from "../core/deviceCache.js";
import { BaseDriver } from "./types.js";

/** Simulated device — `"simulated": true` on any device in the config. No network: state
 *  lives in memory, but it goes through the same store / power engine / groups / presets /
 *  schedule as a real driver, so a demo or kiosk proof-of-concept behaves like the real room.
 *  Powered devices drop off while their EPS output is off and take a few seconds to "boot". */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BOOT_MS = 6000;
const RELAY_STEP_MS = 1000;
const SCENES = ["Showreel", "Product loop", "Welcome", "Black"];
const H_PRESETS = ["Full wall", "Split", "PIP", "Logo"];
const EXVIEW_INPUTS = [{ id: 0, name: "Android" }, { id: 2, name: "HDMI 1", hasSignal: true }, { id: 3, name: "HDMI 2", hasSignal: false }];

export class SimDriver extends BaseDriver {
  /** EPS: 6 relay bits, "1" = on */
  private bits = "000000";
  private sequencing = false;
  private poweredSince = 0;

  constructor(cfg: DeviceConfig) {
    // a copy — never write pollMs back into the live config
    super({ ...cfg, pollMs: cfg.pollMs ?? 1000 });
    // Start from the device cache when there is one — a copied real cache gives the real
    // preset / scene names, and a sim's own cache carries its state across restarts.
    // EPS relay zones always come from the config (their on/off follows the sim's bits).
    const cached = cfg.type === "expromo-eps" ? undefined : getCachedZones(cfg.id);
    this.zoneState = cached?.length ? cached : initialZones(cfg);
    // A real EPS keeps its relays through a restart of eXcontrol (or of the machine it runs
    // on) — so does the simulated one.
    const bits = cfg.type === "expromo-eps" ? getCachedExtra(cfg.id)?.outputs : undefined;
    if (typeof bits === "string" && /^[01]{6}$/.test(bits)) {
      this.bits = bits;
      this.zoneState = this.zoneState.map((z) => (z.relay ? { ...z, on: bits[z.relay - 1] === "1" } : z));
    }
  }

  async start(): Promise<void> {
    this.startPolling(async () => this.tick());
  }

  private tick(): void {
    if (this.type === "expromo-eps") {
      this.online({ extra: this.epsExtra(), zones: this.zoneState });
      return;
    }
    const level = store.powerOf(this.id);
    if (level === "off") {
      this.poweredSince = 0;
      // blackout is volatile on a real controller — it comes back lit after a power cycle
      if (this.zoneState.some((z) => z.blackout)) this.zoneState = this.zoneState.map((z) => ({ ...z, blackout: false }));
      throw new Error("simulated: no power");
    }
    if (!this.poweredSince) this.poweredSince = Date.now();
    if (Date.now() - this.poweredSince < BOOT_MS) throw new Error("simulated: booting");
    const extra = this.type === "obs" ? { programScene: this.activeName() } : undefined;
    this.online({ zones: this.zoneState, ...(extra ? { extra } : {}) });
  }

  private activeName(): string | undefined {
    const z = this.zoneState[0];
    return z?.presets?.find((p) => p.id === z.activePreset)?.name;
  }

  /* ---- H-series / COEX / eXview / OBS ---- */

  async setBrightness(zoneId: string, pct: number): Promise<void> {
    this.zoneById(zoneId);
    this.patchZone(zoneId, { brightness: Math.round(pct) });
  }
  async setVolume(zoneId: string, pct: number): Promise<void> {
    this.zoneById(zoneId);
    this.patchZone(zoneId, { volume: Math.round(pct) });
  }
  async setBlackout(zoneId: string, on: boolean): Promise<void> {
    this.zoneById(zoneId);
    this.patchZone(zoneId, { blackout: on });
  }
  async recallPreset(zoneId: string, presetId: number): Promise<void> {
    const z = this.zoneById(zoneId);
    if (!z.presets?.some((p) => p.id === presetId)) throw new Error(`${this.id}: no preset ${presetId}`);
    this.patchZone(zoneId, { activePreset: presetId });
    if (this.type === "obs") this.patch({ extra: { programScene: this.activeName() } });
  }
  async setPowerState(zoneId: string, state: "on" | "blackout" | "standby"): Promise<void> {
    this.zoneById(zoneId);
    this.patchZone(zoneId, { powerState: state, on: state === "on", blackout: state === "blackout" });
  }

  /* ---- EPS ---- */

  async setOn(zoneId: string, on: boolean): Promise<void> {
    if (this.type === "exview") return this.setPowerState(zoneId, on ? "on" : "standby");
    const idx = this.zoneById(zoneId).relay;
    if (!idx) throw new Error(`${this.id}: "${zoneId}" is not a relay`);
    const desired: (boolean | undefined)[] = Array(6).fill(undefined);
    desired[idx - 1] = on;
    await this.drive(desired, true);
  }

  async action(name: string): Promise<string> {
    if (name === "power_on") await this.drive(Array(6).fill(true));
    else if (name === "power_off") await this.drive(Array(6).fill(false));
    return `OK ${name.toUpperCase()} (simulated) OUTPUTS=${this.bits}`;
  }

  async applyOutputs(desired: (boolean | undefined)[]): Promise<void> {
    await this.drive(desired);
  }

  private async drive(desired: (boolean | undefined)[], allowProtectedOff = false): Promise<void> {
    const cfg = this.cfg.type === "expromo-eps" ? this.cfg : undefined;
    const prot = new Set(allowProtectedOff ? [] : (cfg?.outputs ?? []).filter((o) => o.protected).map((o) => o.index));
    const b = [...this.bits];
    desired.forEach((v, i) => { if (v === false && !prot.has(i + 1)) b[i] = "0"; });
    this.setBits(b.join(""));
    // switch-ons one relay at a time, like the unit's own sequence
    const ons = desired.map((v, i) => (v === true && b[i] === "0" ? i : -1)).filter((i) => i >= 0);
    if (!ons.length) return;
    this.sequencing = true;
    try {
      for (const i of ons) {
        await sleep(RELAY_STEP_MS);
        b[i] = "1";
        this.setBits(b.join(""));
      }
    } finally {
      this.sequencing = false;
      this.setBits(this.bits);
    }
  }

  private setBits(bits: string): void {
    this.bits = bits;
    this.zoneState = this.zoneState.map((z) => (z.relay ? { ...z, on: bits[z.relay - 1] === "1" } : z));
    this.online({ extra: this.epsExtra(), zones: this.zoneState });
  }

  private epsExtra(): Record<string, unknown> {
    const any = this.bits.includes("1");
    const state = this.sequencing ? "SEQUENCING" : this.bits === "111111" ? "FULLY_ON" : any ? "PARTIAL" : "FULLY_OFF";
    return { system: any || this.sequencing ? "ON" : "OFF", state, outputs: this.bits, label: `${this.cfg.label} (simulated)`, simulated: true };
  }
}

function initialZones(cfg: DeviceConfig): ZoneState[] {
  switch (cfg.type) {
    case "novastar-h":
    case "novastar-coex": {
      const zones = cfg.zones.length ? cfg.zones : [{ id: "screen-1", label: "Screen 1", screenId: 0 }];
      return zones.map((z) => ({
        id: z.id,
        label: z.label,
        brightness: 80,
        blackout: false,
        presets: H_PRESETS.map((name, id) => ({ id, name })),
        activePreset: 0,
      }));
    }
    case "obs":
      return [{ id: "scenes", label: "Scenes", presets: SCENES.map((name, id) => ({ id, name })), activePreset: 0 }];
    case "exview":
      return [{ id: "screen", label: "Screen", brightness: 60, volume: 20, presets: EXVIEW_INPUTS, activePreset: 2, on: true, powerState: "on" }];
    case "expromo-eps":
      return cfg.independentOutputs
        ? (cfg.outputs ?? []).map((o) => ({ id: o.id, label: o.label, relay: o.index, on: false }))
        : [];
  }
}
