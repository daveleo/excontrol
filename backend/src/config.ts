import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import type { DeviceType, AppPreset, Schedule } from "@excontrol/shared";
import { BRAND } from "@excontrol/shared";
import { log } from "./logger.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Where the runtime config + logs live. Resolved lazily so the Electron main can set
 * `EXCONTROL_DATA_DIR` after its imports have loaded.
 * - Electron / production: `EXCONTROL_DATA_DIR` (e.g. %ProgramData%\eXcontrol).
 * - Dev: the repo's `config/` folder.
 */
export function getDataDir(): string {
  return process.env.EXCONTROL_DATA_DIR
    ? resolve(process.env.EXCONTROL_DATA_DIR)
    : resolve(here, "../../config");
}
const configFile = () => join(getDataDir(), `${BRAND.slug}.config.json`);

/* ---------- config schema ---------- */

export interface ZoneConfig {
  id: string;
  label: string;
  /** H-series: a number (0,1,…). COEX: the screen GUID string. */
  screenId: number | string;
  /** H-series multi-chassis only. */
  deviceId?: number;
}

export interface BaseDeviceConfig {
  id: string;
  type: DeviceType;
  label: string;
  enabled: boolean;
  host: string;
  port: number;
  pollMs?: number;
  /** id of the EPS that powers this device (null = always on). */
  poweredBy?: string | null;
}

export interface HConfig extends BaseDeviceConfig {
  type: "novastar-h";
  pId: string;
  secretKey: string;
  encrypted?: boolean;
  /** empty => the driver discovers screens on start. */
  zones: ZoneConfig[];
}

export interface CoexConfig extends BaseDeviceConfig {
  type: "novastar-coex";
  zones: ZoneConfig[];
}

export interface EpsConfig extends BaseDeviceConfig {
  type: "expromo-eps";
}

export interface ObsConfig extends BaseDeviceConfig {
  type: "obs";
  password: string;
}

export type DeviceConfig = HConfig | CoexConfig | EpsConfig | ObsConfig;

export interface AppConfig {
  app: { name: string; httpPort: number; bind: string };
  devices: DeviceConfig[];
  presets: AppPreset[];
  schedule: Schedule;
}

const EMPTY_CONFIG: AppConfig = {
  app: { name: BRAND.name, httpPort: 8080, bind: "0.0.0.0" },
  devices: [],
  presets: [],
  schedule: { entries: [] },
};

/* ---------- load / save ---------- */

let current: AppConfig = EMPTY_CONFIG;

export function loadConfig(): AppConfig {
  const dir = getDataDir();
  const file = configFile();
  mkdirSync(dir, { recursive: true });
  if (!existsSync(file)) {
    log.warn({ file }, "no config yet — starting unconfigured (setup wizard)");
    current = structuredClone(EMPTY_CONFIG);
    return current;
  }
  try {
    current = normalise(JSON.parse(readFileSync(file, "utf8")) as Partial<AppConfig>);
  } catch (e) {
    log.error({ err: e, file }, "config unreadable — starting unconfigured");
    current = structuredClone(EMPTY_CONFIG);
  }
  validate(current);
  return current;
}

/** In-memory config (post-load). Mutated by presets.ts / schedule.ts / the wizard, then persisted. */
export function getConfig(): AppConfig {
  return current;
}

export function saveConfig(next: AppConfig): AppConfig {
  validate(next);
  current = next;
  const file = configFile();
  try {
    mkdirSync(getDataDir(), { recursive: true });
    const tmp = file + ".tmp";
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, file);
  } catch (e) {
    log.error({ err: e, file }, "failed to persist config");
  }
  return current;
}

/** True once at least one device is configured. */
export function isConfigured(): boolean {
  return current.devices.length > 0;
}

/* ---------- helpers ---------- */

function normalise(p: Partial<AppConfig>): AppConfig {
  return {
    app: {
      name: p.app?.name || BRAND.name,
      httpPort: p.app?.httpPort || 8080,
      bind: p.app?.bind || "0.0.0.0",
    },
    devices: Array.isArray(p.devices) ? (p.devices as DeviceConfig[]) : [],
    presets: Array.isArray(p.presets) ? p.presets : [],
    schedule: p.schedule && Array.isArray(p.schedule.entries) ? p.schedule : { entries: [] },
  };
}

function validate(cfg: AppConfig): void {
  const ids = new Set<string>();
  for (const d of cfg.devices) {
    if (!d.id) throw new Error("config: a device is missing its id");
    if (ids.has(d.id)) throw new Error(`config: duplicate device id "${d.id}"`);
    ids.add(d.id);
    if (!d.host || !d.port) throw new Error(`config: device "${d.id}" missing host/port`);
    if ((d.type === "novastar-h" || d.type === "novastar-coex") && d.zones) {
      const zids = new Set<string>();
      for (const z of d.zones) {
        if (zids.has(z.id)) throw new Error(`config: device "${d.id}" has duplicate zone id "${z.id}"`);
        zids.add(z.id);
      }
    }
  }
  for (const d of cfg.devices) {
    if (d.poweredBy) {
      const eps = cfg.devices.find((x) => x.id === d.poweredBy);
      if (!eps || eps.type !== "expromo-eps") {
        throw new Error(`config: device "${d.id}".poweredBy "${d.poweredBy}" is not an EPS`);
      }
    }
  }
}
