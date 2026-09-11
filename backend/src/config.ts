import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import type { DeviceType, AppPreset, Schedule, SetupDevice, SetupState, SetupSaveBody } from "@excontrol/shared";
import { BRAND, SECRET_KEPT } from "@excontrol/shared";
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
  app: {
    name: string;
    httpPort: number;
    bind: string;
    /** scrypt hash + salt of the settings password, hex. Absent = settings unlocked. */
    settingsPasswordHash?: string;
    settingsPasswordSalt?: string;
  };
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
      httpPort: Number(p.app?.httpPort) || 8080,
      bind: p.app?.bind || "0.0.0.0",
      settingsPasswordHash: p.app?.settingsPasswordHash,
      settingsPasswordSalt: p.app?.settingsPasswordSalt,
    },
    devices: Array.isArray(p.devices) ? (p.devices as DeviceConfig[]) : [],
    presets: Array.isArray(p.presets) ? p.presets : [],
    schedule: p.schedule && Array.isArray(p.schedule.entries) ? p.schedule : { entries: [] },
  };
}

/** True once a settings password is set — the setup/preset/schedule *editing* endpoints require it. */
export function isSettingsLocked(): boolean {
  return !!current.app.settingsPasswordHash;
}

/* ---------- setup wizard ---------- */

const DEFAULT_PORTS: Record<DeviceType, number> = {
  "novastar-h": 8000,
  "novastar-coex": 8001,
  "expromo-eps": 5000,
  obs: 4455,
};

/** Flatten a stored device to the wizard's editing shape, with secrets redacted. */
function toSetupDevice(d: DeviceConfig): SetupDevice {
  const base: SetupDevice = {
    id: d.id,
    type: d.type,
    label: d.label,
    enabled: d.enabled,
    host: d.host,
    port: d.port,
    poweredBy: d.poweredBy ?? null,
  };
  if (d.type === "novastar-h") {
    base.pId = d.pId;
    base.secretKey = d.secretKey ? SECRET_KEPT : "";
    base.encrypted = !!d.encrypted;
    base.zones = d.zones ?? [];
  }
  if (d.type === "novastar-coex") base.zones = d.zones ?? [];
  if (d.type === "obs") base.password = d.password ? SECRET_KEPT : "";
  return base;
}

export function toSetupState(): SetupState {
  return {
    configured: isConfigured(),
    app: { name: current.app.name, httpPort: current.app.httpPort, bind: current.app.bind },
    settingsLocked: isSettingsLocked(),
    devices: current.devices.map(toSetupDevice),
    defaultPorts: DEFAULT_PORTS,
  };
}

/** Replace SECRET_KEPT sentinels in a wizard device with the value already on disk. */
export function resolveSecrets(input: SetupDevice): SetupDevice {
  const stored = current.devices.find((d) => d.id === input.id);
  const out = { ...input };
  if (out.secretKey === SECRET_KEPT) out.secretKey = stored?.type === "novastar-h" ? stored.secretKey : "";
  if (out.password === SECRET_KEPT) out.password = stored?.type === "obs" ? stored.password : "";
  return out;
}

/** Build a stored DeviceConfig from a wizard device (resolving kept secrets). */
function fromSetupDevice(input: SetupDevice): DeviceConfig {
  const d = resolveSecrets(input);
  const host = (d.host || "").trim();
  const port = Number(d.port) || DEFAULT_PORTS[d.type];
  const common = {
    id: d.id.trim(),
    label: (d.label || "").trim() || d.id.trim(),
    enabled: d.enabled !== false,
    host,
    port,
    poweredBy: d.poweredBy || null,
  };
  switch (d.type) {
    case "novastar-h":
      return {
        ...common, type: "novastar-h",
        pId: (d.pId || "").trim(),
        secretKey: (d.secretKey || "").trim(),
        encrypted: !!d.encrypted,
        zones: cleanZones(d.zones, "number"),
      };
    case "novastar-coex":
      return { ...common, type: "novastar-coex", zones: cleanZones(d.zones, "string") };
    case "expromo-eps":
      return { ...common, type: "expromo-eps" };
    case "obs":
      return { ...common, type: "obs", password: d.password || "" };
  }
}

function cleanZones(zones: SetupDevice["zones"], screenIdKind: "number" | "string"): ZoneConfig[] {
  return (zones ?? [])
    .filter((z) => z && String(z.id).trim())
    .map((z) => ({
      id: String(z.id).trim(),
      label: (z.label || "").trim() || String(z.id).trim(),
      screenId: screenIdKind === "number" ? Number(z.screenId) || 0 : String(z.screenId ?? "").trim(),
      ...(z.deviceId != null ? { deviceId: Number(z.deviceId) || 0 } : {}),
    }));
}

/** Validate + persist a wizard submission. Presets/schedule are left untouched. */
export function applySetup(body: SetupSaveBody): AppConfig {
  const seenIds = new Set<string>();
  for (const d of body.devices) {
    const id = (d.id || "").trim();
    if (!id) throw new Error("every device needs an id");
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) throw new Error(`device id "${id}" — use letters, digits and hyphens only`);
    if (seenIds.has(id)) throw new Error(`duplicate device id "${id}"`);
    seenIds.add(id);
  }
  const next: AppConfig = {
    app: {
      name: (body.app?.name ?? current.app.name) || BRAND.name,
      httpPort: Number(body.app?.httpPort ?? current.app.httpPort) || 8080,
      bind: body.app?.bind ?? current.app.bind ?? "0.0.0.0",
      // the wizard doesn't manage the settings password — carry it through untouched
      settingsPasswordHash: current.app.settingsPasswordHash,
      settingsPasswordSalt: current.app.settingsPasswordSalt,
    },
    devices: body.devices.map(fromSetupDevice),
    presets: current.presets,
    schedule: current.schedule,
  };
  return saveConfig(next); // saveConfig runs validate(), incl. the port range check
}

/** Full config for export/pre-staging — device secrets included (that's the point), the
 *  settings password excluded (it's per-install, it shouldn't travel with the site config). */
export function exportConfig(): Record<string, unknown> {
  const { settingsPasswordHash: _h, settingsPasswordSalt: _s, ...app } = current.app;
  return { ...current, app };
}

/** Import a whole config file (from exportConfig, or hand-written to this shape). This
 *  machine's settings password (if any) is always kept — a password doesn't travel with
 *  an imported site config, even if the file happens to carry one. */
export function importConfig(raw: unknown): AppConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("not a valid eXcontrol config file");
  }
  const parsed = normalise(raw as Partial<AppConfig>);
  const next: AppConfig = {
    ...parsed,
    app: {
      ...parsed.app,
      settingsPasswordHash: current.app.settingsPasswordHash,
      settingsPasswordSalt: current.app.settingsPasswordSalt,
    },
  };
  return saveConfig(next);
}

function validate(cfg: AppConfig): void {
  const port = cfg.app.httpPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`config: httpPort must be 1-65535 (got ${port})`);
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
