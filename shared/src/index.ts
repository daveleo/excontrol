/**
 * The API / WebSocket contract between backend and front-end. Framework-free.
 */
export * from "./branding.js";
export * from "./schedule.js";
export * from "./setup.js";

/* ---------- devices ---------- */

export type DeviceType = "novastar-h" | "novastar-coex" | "expromo-eps" | "obs";

export type ConnectionStatus =
  | "connecting"
  | "online"
  | "initializing" // reachable but still booting (e.g. H-series status 912)
  | "powered-off"  // unreachable and its power domain reports off — expected, not a fault
  | "offline"      // unreachable for another reason — a fault
  | "error";

/** A preset/scene the device itself can recall (H-series/COEX presets, OBS scenes). */
export interface Preset {
  id: number;
  name: string;
}

/** One controllable screen on a controller. EPS has none; OBS has one (its scene list). */
export interface ZoneState {
  id: string;
  label: string;
  brightness?: number; // 0..100
  blackout?: boolean;
  presets?: Preset[];
  activePreset?: number;
}

export interface DeviceState {
  id: string;
  type: DeviceType;
  label: string;
  status: ConnectionStatus;
  error?: string;
  lastSeen?: number;
  /** id of the EPS that powers this device, or null/undefined for "always on". */
  poweredBy?: string | null;
  zones: ZoneState[];
  /** device-type extras: EPS status fields, OBS programScene, … */
  extra?: Record<string, unknown>;
}

/* ---------- power domains ---------- */

export type PowerLevel = "on" | "off" | "starting" | "unknown";

/** id used for the group of devices with no `poweredBy`. */
export const ALWAYS_ON_DOMAIN = "__always_on__";

export interface PowerDomain {
  /** the EPS device id, or ALWAYS_ON_DOMAIN */
  id: string;
  label: string;
  level: PowerLevel;
  headline: string;
  detail?: string;
  /** device ids in this domain */
  members: string[];
  /** absent for the always-on group */
  eps?: {
    system?: string;
    state?: string;
    outputs?: string;
    outputsOff: number[];
    reachable: boolean;
  };
}

/* ---------- presets (saved cross-device configurations) ---------- */

export interface PresetAction {
  /** "<deviceId>" or "<deviceId>:<zoneId>" */
  target: string;
  brightness?: number; // 0..100 — H/COEX zone
  preset?: number;     // recall this zone's preset id
  blackout?: boolean;  // H/COEX zone
  scene?: string;      // OBS scene name
  power?: "on" | "off"; // EPS device
}

export interface AppPreset {
  id: string;
  label: string;
  actions: PresetAction[];
  /** apply automatically when this power domain turns on: an EPS id, "all", or null. */
  powerOnDefaultFor?: string | null;
}

/* ---------- scheduler ---------- */

export type ScheduleAction = "power_on" | "power_off" | "apply_preset";

export interface ScheduleEntry {
  id: string;
  label: string;
  time: string;   // "HH:MM" 24h local
  days: number[]; // 0=Sun..6=Sat; [] = every day
  action: ScheduleAction;
  /** power_on / power_off: an EPS id or "all". */
  target?: string;
  /** apply_preset: the preset id. */
  presetId?: string;
  /** reserved for per-EPS-output scheduling — not yet implemented. */
  outputs?: number[];
  enabled: boolean;
}

export interface Schedule {
  entries: ScheduleEntry[];
  lastRun?: { id: string; at: number; action: ScheduleAction };
  /** ms timestamp the postponed shutdown will fire (0/absent = no active extension). */
  snoozeUntil?: number;
  /** total hours the shutdown has been pushed back, for display. */
  snoozeHours?: number;
}

/* ---------- full state ---------- */

export interface AppInfo {
  name: string;       // display name (config app.name, else BRAND.name)
  version: string;    // package version
  startedAt: number;
  /** false → the setup wizard should be shown */
  configured: boolean;
}

export interface AppState {
  app: AppInfo;
  devices: DeviceState[];
  powerDomains: PowerDomain[];
  presets: AppPreset[];
  schedule: Schedule;
  updatesPaused: boolean;
}

/* ---------- WebSocket messages (server → client) ---------- */

export type ServerMessage =
  | { t: "snapshot"; state: AppState }
  | { t: "device"; device: DeviceState }
  | { t: "power"; domains: PowerDomain[] }
  | { t: "presets"; presets: AppPreset[] }
  | { t: "schedule"; schedule: Schedule }
  | { t: "reload"; reason: string }
  | { t: "toast"; level: "info" | "warn" | "error"; text: string };

/* ---------- HTTP bodies (client → server) ---------- */

export interface SetBrightnessBody { brightness: number }
export interface RecallPresetBody { presetId: number }
export interface SetBlackoutBody { blackout: boolean }
export interface SnoozeBody { hours?: number; clear?: boolean }
export interface ApiError { error: string }
