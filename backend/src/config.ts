import { readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import type {
  DeviceType, AppPreset, Schedule, SetupDevice, SetupState, SetupSaveBody, AppSettingsBody, GroupConfig, ConfigRecovery,
} from "@excontrol/shared";
import { BRAND, SECRET_KEPT } from "@excontrol/shared";
import { log } from "./logger.js";
import { writeFileDurable } from "./core/durableWrite.js";

/** The config change was applied in memory but could not be written to disk. */
export class ConfigPersistError extends Error {
  constructor(detail: string) {
    super(`Couldn't save the settings to disk (${detail}) — the change is active until the next restart`);
    this.name = "ConfigPersistError";
  }
}

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
  /** the relay (1-6) of that EPS this device hangs off; null = the whole unit (every output
   *  no other device claims). */
  poweredByOutput?: number | null;
  /** demo / proof-of-concept: an in-memory device, no network (drivers/sim.ts) */
  simulated?: boolean;
  /** presets hidden from the dashboards, "zoneId:presetId" */
  hiddenPresets?: string[];
  /** customer names for inputs ("input 4-1" → "Laptop") */
  inputNames?: Record<string, string>;
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

export interface EpsOutputConfig {
  id: string;
  label: string;
  /** 1-based physical relay number, matches OUTx_ON/OFF. */
  index: number;
  /** never switched off by whole-unit power off, groups or schedules */
  protected?: boolean;
}

export interface EpsConfig extends BaseDeviceConfig {
  type: "expromo-eps";
  /** off by default; the whole-unit Power on/off button is unaffected either way. */
  independentOutputs?: boolean;
  outputs?: EpsOutputConfig[];
  /** minimum time an output stays off before eXcontrol switches it back on (default 30) */
  minOffSeconds?: number;
}

export interface ObsConfig extends BaseDeviceConfig {
  type: "obs";
  password: string;
}

export interface ExviewConfig extends BaseDeviceConfig {
  type: "exview";
  /** Edge has 2 HDMI inputs, AIO has 4 — same protocol, different input count. */
  model: "edge" | "aio";
}

export type DeviceConfig = HConfig | CoexConfig | EpsConfig | ObsConfig | ExviewConfig;

export interface AppConfig {
  app: {
    name: string;
    httpPort: number;
    bind: string;
    /** scrypt hash + salt of the settings password, hex. Absent = settings unlocked. */
    settingsPasswordHash?: string;
    settingsPasswordSalt?: string;
    /** launch at Windows login (desktop only — ignored from source/CLI). Default true to
     *  match every install's behaviour before this was a toggle. */
    autoStart: boolean;
  };
  devices: DeviceConfig[];
  presets: AppPreset[];
  schedule: Schedule;
  groups: GroupConfig[];
}

const EMPTY_CONFIG: AppConfig = {
  app: { name: BRAND.name, httpPort: 8080, bind: "0.0.0.0", autoStart: true },
  devices: [],
  presets: [],
  schedule: { entries: [] },
  groups: [],
};

/* ---------- load / save ---------- */

let current: AppConfig = EMPTY_CONFIG;
let recovery: ConfigRecovery | undefined;

/** Set when the config file was unusable at start-up — shown to every browser until the next
 *  successful save. */
export function getConfigRecovery(): ConfigRecovery | undefined {
  return recovery;
}

const lastGoodFile = () => join(getDataDir(), "excontrol.config.last-good.json");

/** Parse + normalise + validate, or throw. A file that is valid JSON but fails validation
 *  (e.g. two devices on one EPS output) used to throw *outside* the try → the backend exited
 *  on every start: a permanent crash loop. */
function readValidConfig(file: string): AppConfig {
  const c = normalise(JSON.parse(readFileSync(file, "utf8")) as Partial<AppConfig>);
  validate(c);
  return c;
}

/** Keep a copy of the last config that loaded or saved cleanly. Written only on change. */
function rememberGood(c: AppConfig): void {
  const text = JSON.stringify(c, null, 2);
  try {
    if (existsSync(lastGoodFile()) && readFileSync(lastGoodFile(), "utf8") === text) return;
    writeFileDurable(lastGoodFile(), text);
  } catch (e) {
    log.warn({ err: e }, "could not update the last-good config copy");
  }
}

export function loadConfig(): AppConfig {
  const dir = getDataDir();
  const file = configFile();
  mkdirSync(dir, { recursive: true });
  recovery = undefined;
  if (!existsSync(file)) {
    log.warn({ file }, "no config yet — starting unconfigured (setup wizard)");
    current = structuredClone(EMPTY_CONFIG);
    return current;
  }
  try {
    current = readValidConfig(file);
    rememberGood(current);
    return current;
  } catch (e) {
    // Never leave a damaged file where a later save would overwrite it — keep it for forensics.
    const keptAs = `excontrol.config.damaged-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    try {
      renameSync(file, join(dir, keptAs));
    } catch (e2) {
      log.error({ err: e2 }, "could not move the damaged config aside");
    }
    recovery = { at: Date.now(), reason: e instanceof Error ? e.message.slice(0, 200) : String(e), keptAs, restored: false };
    log.error({ err: e, file, keptAs }, "config unreadable or invalid — trying the last good copy");
  }
  try {
    current = readValidConfig(lastGoodFile());
    writeFileDurable(file, JSON.stringify(current, null, 2));
    recovery!.restored = true;
    log.warn({ keptAs: recovery!.keptAs }, "restored the last good config");
  } catch (e) {
    log.error({ err: e }, "no usable last-good config — starting unconfigured");
    current = structuredClone(EMPTY_CONFIG);
  }
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
    writeFileDurable(file, JSON.stringify(next, null, 2));
    rememberGood(next);
    recovery = undefined; // a clean save supersedes the start-up recovery notice
  } catch (e) {
    log.error({ err: e, file }, "failed to persist config");
    // The change is live in memory but would be lost on restart — the caller must say so.
    throw new ConfigPersistError(e instanceof Error ? e.message : String(e));
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
      autoStart: p.app?.autoStart !== false,
    },
    devices: Array.isArray(p.devices) ? (p.devices as DeviceConfig[]) : [],
    presets: Array.isArray(p.presets) ? p.presets : [],
    schedule: p.schedule && Array.isArray(p.schedule.entries) ? p.schedule : { entries: [] },
    groups: Array.isArray(p.groups) ? p.groups : [],
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
  exview: 8600,
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
    poweredByOutput: d.poweredByOutput ?? null,
    ...(d.simulated ? { simulated: true } : {}),
    ...(d.hiddenPresets?.length ? { hiddenPresets: d.hiddenPresets } : {}),
    ...(d.inputNames && Object.keys(d.inputNames).length ? { inputNames: d.inputNames } : {}),
  };
  if (d.type === "novastar-h") {
    base.pId = d.pId;
    base.secretKey = d.secretKey ? SECRET_KEPT : "";
    base.encrypted = !!d.encrypted;
    base.zones = d.zones ?? [];
  }
  if (d.type === "novastar-coex") base.zones = d.zones ?? [];
  if (d.type === "expromo-eps") {
    base.independentOutputs = !!d.independentOutputs;
    base.outputs = d.outputs ?? [];
  }
  if (d.type === "obs") base.password = d.password ? SECRET_KEPT : "";
  if (d.type === "exview") base.model = d.model;
  return base;
}

export function toSetupState(): SetupState {
  return {
    configured: isConfigured(),
    app: {
      name: current.app.name, httpPort: current.app.httpPort, bind: current.app.bind,
      autoStart: current.app.autoStart,
    },
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

/** Dashboard presentation settings from the wizard, validated: "zone:number" keys, short names. */
function cleanPresentation(d: SetupDevice): Pick<BaseDeviceConfig, "hiddenPresets" | "inputNames"> {
  const hidden = Array.isArray(d.hiddenPresets)
    ? [...new Set(d.hiddenPresets.filter((k) => typeof k === "string" && /^[^:]{1,64}:-?\d{1,6}$/.test(k)))].slice(0, 500)
    : [];
  const names: Record<string, string> = {};
  for (const [k, v] of Object.entries(d.inputNames ?? {})) {
    const key = String(k).slice(0, 64);
    const val = typeof v === "string" ? v.trim().slice(0, 40) : "";
    if (key && val) names[key] = val;
  }
  return {
    ...(hidden.length ? { hiddenPresets: hidden } : {}),
    ...(Object.keys(names).length ? { inputNames: names } : {}),
  };
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
    poweredByOutput: d.poweredBy && Number(d.poweredByOutput) >= 1 && Number(d.poweredByOutput) <= 6
      ? Number(d.poweredByOutput) : null,
    ...(d.simulated ? { simulated: true } : {}),
    ...cleanPresentation(d),
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
      return {
        ...common, type: "expromo-eps",
        independentOutputs: !!d.independentOutputs,
        outputs: cleanOutputs(d.outputs),
        // not edited in the wizard — carried over so a wizard save doesn't reset it
        ...(() => {
          const stored = current.devices.find((x) => x.id === common.id);
          return stored?.type === "expromo-eps" && stored.minOffSeconds != null ? { minOffSeconds: stored.minOffSeconds } : {};
        })(),
      };
    case "obs":
      return { ...common, type: "obs", password: d.password || "" };
    case "exview":
      return { ...common, type: "exview", model: d.model === "aio" ? "aio" : "edge" };
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

function cleanOutputs(outputs: SetupDevice["outputs"]): EpsOutputConfig[] {
  return (outputs ?? [])
    .filter((o) => o && String(o.id).trim())
    .map((o) => ({
      id: String(o.id).trim(),
      label: (o.label || "").trim() || String(o.id).trim(),
      index: Number(o.index) || 0,
      ...(o.protected ? { protected: true } : {}),
    }))
    .filter((o) => o.index >= 1 && o.index <= 6);
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
      // the device wizard doesn't manage the settings password or autostart — carry both
      // through untouched (Settings owns those).
      settingsPasswordHash: current.app.settingsPasswordHash,
      settingsPasswordSalt: current.app.settingsPasswordSalt,
      autoStart: current.app.autoStart,
    },
    devices: body.devices.map(fromSetupDevice),
    presets: current.presets,
    schedule: current.schedule,
    groups: current.groups,
  };
  // a removed device drops out of every group rather than failing validation
  const ids = new Set(next.devices.map((d) => d.id));
  next.groups = next.groups.map((g) => ({ ...g, members: g.members.filter((m) => ids.has(m)) }));
  return saveConfig(next); // saveConfig runs validate(), incl. the port range check
}

/** Validate + persist a Settings-panel submission (name/port/bind/autostart). Devices,
 *  presets, schedule and the access password are all left untouched — that's the device
 *  wizard's and the password endpoints' job, not this one's. */
export function applyAppSettings(body: AppSettingsBody): AppConfig {
  const next: AppConfig = {
    ...current,
    app: {
      ...current.app,
      name: (body.name ?? current.app.name) || BRAND.name,
      httpPort: Number(body.httpPort ?? current.app.httpPort) || 8080,
      bind: body.bind ?? current.app.bind ?? "0.0.0.0",
      autoStart: body.autoStart ?? current.app.autoStart,
    },
  };
  return saveConfig(next);
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
    if (d.type === "expromo-eps" && d.outputs) {
      const oids = new Set<string>();
      const oidx = new Set<number>();
      for (const o of d.outputs) {
        if (oids.has(o.id)) throw new Error(`config: device "${d.id}" has duplicate output id "${o.id}"`);
        oids.add(o.id);
        if (oidx.has(o.index)) throw new Error(`config: device "${d.id}" has duplicate output index ${o.index}`);
        oidx.add(o.index);
      }
    }
  }
  const claimed = new Map<string, string>();
  for (const d of cfg.devices) {
    if (d.poweredBy) {
      const eps = cfg.devices.find((x) => x.id === d.poweredBy);
      if (!eps || eps.type !== "expromo-eps") {
        throw new Error(`config: device "${d.id}".poweredBy "${d.poweredBy}" is not an EPS`);
      }
    }
    if (d.poweredByOutput != null) {
      if (!d.poweredBy) throw new Error(`config: device "${d.id}" has an output but no EPS`);
      if (!Number.isInteger(d.poweredByOutput) || d.poweredByOutput < 1 || d.poweredByOutput > 6) {
        throw new Error(`config: device "${d.id}".poweredByOutput must be 1-6`);
      }
      const key = `${d.poweredBy}:${d.poweredByOutput}`;
      const other = claimed.get(key);
      if (other) throw new Error(`config: "${d.id}" and "${other}" are both on output ${d.poweredByOutput} of "${d.poweredBy}"`);
      claimed.set(key, d.id);
    }
  }
  const gids = new Set<string>();
  for (const g of cfg.groups ?? []) {
    if (!g.id || !/^[a-z0-9][a-z0-9-]*$/i.test(g.id)) throw new Error(`config: group id "${g.id}" — use letters, digits and hyphens`);
    if (g.id === "all") throw new Error(`config: "all" is reserved for Everything`);
    if (gids.has(g.id)) throw new Error(`config: duplicate group id "${g.id}"`);
    gids.add(g.id);
    for (const m of g.members) if (!ids.has(m)) throw new Error(`config: group "${g.id}" names unknown device "${m}"`);
  }
}
