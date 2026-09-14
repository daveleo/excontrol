import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { DeviceState, PowerDomain, AppState, AppInfo, UpdateInfo, ZoneState } from "@excontrol/shared";
import { BRAND } from "@excontrol/shared";
import { bus, type DevicePatch } from "./bus.js";
import { getConfig, isConfigured, isSettingsLocked } from "../config.js";
import { rememberZones } from "./deviceCache.js";
import { log } from "../logger.js";

/**
 * A driver rebuilding its zone list from scratch (on its first successful poll, or after a
 * reconnect) only knows fresh identity + whatever it just read — e.g. NovaStar's
 * `ensureZones()` sends bare `{ id, label }` before brightness/presets are known for this
 * process lifetime. Without this merge, that bare patch would blank out perfectly good
 * cached data (restored from disk at boot, see deviceCache.ts) for the split second before
 * the real values arrive — or forever, if the device never finishes coming online. Only
 * fields the incoming zone actually sets (not merely present-as-undefined, as EPS's
 * `{ on: undefined }` placeholder is) are allowed to overwrite what we already had.
 */
function mergeZones(prev: ZoneState[], incoming: ZoneState[]): ZoneState[] {
  return incoming.map((z) => {
    const old = prev.find((p) => p.id === z.id);
    if (!old) return z;
    const merged = { ...old } as Record<string, unknown>;
    for (const [k, v] of Object.entries(z)) {
      if (v !== undefined) merged[k] = v;
    }
    return merged as unknown as ZoneState;
  });
}

const here = dirname(fileURLToPath(import.meta.url));
function pkgVersion(): string {
  if (process.env.EXCONTROL_VERSION) return process.env.EXCONTROL_VERSION;
  try {
    return JSON.parse(readFileSync(resolve(here, "../../package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Single source of truth for UI-facing state. Drivers emit "device:patch"; we merge and
 * broadcast. Presets + schedule live in the config file (config.ts), not here.
 */
class Store {
  private devices = new Map<string, DeviceState>();
  private domains = new Map<string, PowerDomain>();
  readonly startedAt = Date.now();
  private updateInfo: UpdateInfo | null = null;

  /** Electron main pushes what electron-updater learns here, via /api/internal/update-status. */
  setUpdateInfo(info: UpdateInfo): void {
    this.updateInfo = info;
    bus.emit("broadcast", { t: "update", info });
  }

  get version(): string {
    return pkgVersion();
  }

  private wired = false;

  init(seed: DeviceState[]) {
    this.devices.clear();
    for (const d of seed) this.devices.set(d.id, d);
    // Subscribe exactly once — init() is called again on a config reload.
    if (!this.wired) {
      this.wired = true;
      bus.on("device:patch", (p) => this.apply(p));
    }
  }

  private apply(patch: DevicePatch) {
    const prev = this.devices.get(patch.id);
    if (!prev) {
      log.warn({ id: patch.id }, "patch for unknown device");
      return;
    }
    const next: DeviceState = {
      ...prev,
      ...patch,
      zones: patch.zones ? mergeZones(prev.zones, patch.zones) : prev.zones,
      extra: patch.extra ? { ...prev.extra, ...patch.extra } : prev.extra,
    };
    this.devices.set(patch.id, next);
    if (next.status === "online") rememberZones(next.id, next.zones, next.lastSeen ?? Date.now(), next.extra);
    bus.emit("broadcast", { t: "device", device: next });
  }

  get(id: string): DeviceState | undefined {
    return this.devices.get(id);
  }
  all(): DeviceState[] {
    return [...this.devices.values()];
  }

  /** returns the domain ids whose state changed */
  setDomains(list: PowerDomain[]): string[] {
    const changed: string[] = [];
    for (const d of list) {
      const prev = this.domains.get(d.id);
      if (!prev || JSON.stringify(prev) !== JSON.stringify(d)) changed.push(d.id);
      this.domains.set(d.id, d);
    }
    for (const id of [...this.domains.keys()]) {
      if (!list.some((d) => d.id === id)) {
        this.domains.delete(id);
        changed.push(id);
      }
    }
    return changed;
  }
  domainsList(): PowerDomain[] {
    return [...this.domains.values()];
  }
  domainOf(deviceId: string): PowerDomain | undefined {
    return this.domainsList().find((d) => d.members.includes(deviceId));
  }

  appInfo(): AppInfo {
    return {
      name: getConfig().app.name || BRAND.name,
      version: this.version,
      startedAt: this.startedAt,
      configured: isConfigured(),
      settingsLocked: isSettingsLocked(),
    };
  }

  snapshot(): AppState {
    const cfg = getConfig();
    return {
      app: this.appInfo(),
      devices: this.all(),
      powerDomains: this.domainsList(),
      presets: cfg.presets,
      schedule: cfg.schedule,
      updateInfo: this.updateInfo,
    };
  }
}

export const store = new Store();
