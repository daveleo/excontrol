/**
 * The API / WebSocket contract between backend and front-end. Framework-free.
 */
export * from "./branding.js";
export * from "./schedule.js";
export * from "./setup.js";
export * from "./auth.js";
export * from "./update.js";
import type { UpdateInfo } from "./update.js";

/* ---------- devices ---------- */

export type DeviceType = "novastar-h" | "novastar-coex" | "expromo-eps" | "obs" | "exview";

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
  /** live signal-presence for a physical input (eXview HDMI ports) — absent where the
   *  concept doesn't apply (a saved preset, an internal source like Android, etc.). */
  hasSignal?: boolean;
}

/** One controllable screen on a controller, or (for an EPS with independent output
 *  control enabled) one named relay. EPS has none by default; OBS has one (its scenes). */
export interface ZoneState {
  id: string;
  label: string;
  brightness?: number; // 0..100
  volume?: number; // 0..100 — eXview
  blackout?: boolean;
  presets?: Preset[];
  activePreset?: number;
  /** a plain on/off zone (EPS relay, or an eXview's own power state) rather than a brightness one */
  on?: boolean;
  /** EPS output zones: the physical relay number (1-6) */
  relay?: number;
  /** eXview only: the real power state, richer than `on` above — a prolonged blackout can
   *  auto-transition into a restricted "standby" the device's own firmware enters after a
   *  configurable timeout (set on the device itself, invisible to this app until it happens),
   *  not just whatever this app last commanded. `on` mirrors this (true only for "on"). */
  powerState?: "on" | "blackout" | "standby";
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
  /** the one EPS relay (1-6) this device hangs off. null/undefined = the whole unit, i.e.
   *  every output of that EPS not claimed by another device's poweredByOutput. */
  poweredByOutput?: number | null;
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
  /** true when the only thing noteworthy is that some outputs are off (PARTIAL_ON) — the
   *  top banner leaves that to the EPS card instead of alarming everyone about it. */
  partial?: boolean;
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
  brightness?: number; // 0..100 — H/COEX zone, eXview
  volume?: number;     // 0..100 — eXview
  preset?: number;     // recall this zone's preset id
  blackout?: boolean;  // H/COEX zone
  scene?: string;      // OBS scene name
  power?: "on" | "off"; // EPS device (whole unit)
  on?: boolean;         // EPS relay zone (independent output control), or an eXview's power state
}

export interface AppPreset {
  id: string;
  label: string;
  actions: PresetAction[];
  /** apply automatically when this power domain turns on: an EPS id, "all", or null. */
  powerOnDefaultFor?: string | null;
}

/* ---------- scheduler ---------- */

export type ScheduleAction = "power_on" | "power_off" | "standby" | "apply_preset";

export interface ScheduleEntry {
  id: string;
  label: string;
  time: string;   // "HH:MM" 24h local
  days: number[]; // 0=Sun..6=Sat; [] = every day
  action: ScheduleAction;
  /** power_on / power_off / standby: "all" (Everything), "group:<id>", or an EPS id
   *  (that one unit's whole-unit power, the pre-0.3 behaviour). */
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
  /** the entry whose occurrence was extended — only that entry is held back, and only its
   *  own target fires when the extension runs out. Absent on pre-0.3 configs (then the
   *  extension applies to whichever shutdown was next, as before, but still fires only it). */
  snoozeEntryId?: string;
}

/* ---------- power groups ---------- */

/** What a group (or "Everything") is asked to be. Ordered: on > standby > off. */
export type PowerTarget = "on" | "standby" | "off";

/** id of the implicit group containing every device. */
export const ALL_GROUP = "all";

/** What the room-wide group is called on screen: the installation's display name (e.g.
 *  "Showroom"), or "Everything" while it still has the product's default name. */
export function roomLabel(appName?: string): string {
  const n = (appName ?? "").trim();
  return !n || n.toLowerCase() === "excontrol" ? "Everything" : n;
}

export interface GroupConfig {
  id: string;
  label: string;
  /** device ids. A device may be in several groups — it then follows the highest target
   *  among them (on beats standby beats off). */
  members: string[];
}

export interface GroupState {
  id: string;
  label: string;
  members: string[];
  target?: PowerTarget;
  /** who set the target: "Dashboard", "Schedule: Power off", "Companion"… */
  setBy?: string;
  setAt?: number;
  busy: boolean;
  /** one line of what the engine is doing right now for this group */
  progress?: string;
  /** observed, e.g. "2 on · 1 standby · 1 off" */
  summary: string;
}

/** The engine's resolved view of one device: what it should be, and why. */
export interface DeviceTarget {
  deviceId: string;
  target?: PowerTarget;
  /** labels of the groups that decided the target (the highest ones) */
  via: string[];
  /** a manual device-level command has overridden the group target until its next change */
  manual?: boolean;
  /** it's meant to be Off, but its power stays on because these devices (labels) still need
   *  the same EPS relay — the one case a card should explain itself */
  heldBy?: string[];
  /** plain-language consequence, e.g. "EPS output 3 switched off", "held on: shares
   *  power with NovaStar COEX (On via Demo corner) — blacked out instead" */
  effect?: string;
}

export interface PowerAlert {
  id: string;
  at: number;
  level: "info" | "warn";
  text: string;
  deviceId?: string;
}

/* ---------- full state ---------- */

export interface AppInfo {
  name: string;       // display name (config app.name, else BRAND.name)
  version: string;    // package version
  startedAt: number;
  /** false → the setup wizard should be shown */
  configured: boolean;
  /** true → device setup / preset & schedule editing require the settings password */
  settingsLocked: boolean;
}

export interface AppState {
  app: AppInfo;
  devices: DeviceState[];
  powerDomains: PowerDomain[];
  presets: AppPreset[];
  schedule: Schedule;
  /** "Everything" (id ALL_GROUP) first, then the configured groups */
  groups: GroupState[];
  deviceTargets: DeviceTarget[];
  alerts: PowerAlert[];
  /** null outside Electron, or before the first check has completed */
  updateInfo: UpdateInfo | null;
}

/* ---------- WebSocket messages (server → client) ---------- */

export type ServerMessage =
  | { t: "snapshot"; state: AppState }
  | { t: "device"; device: DeviceState }
  | { t: "power"; domains: PowerDomain[] }
  | { t: "presets"; presets: AppPreset[] }
  | { t: "schedule"; schedule: Schedule }
  | { t: "groups"; groups: GroupState[]; deviceTargets: DeviceTarget[] }
  | { t: "alerts"; alerts: PowerAlert[] }
  | { t: "update"; info: UpdateInfo }
  | { t: "reload"; reason: string }
  | { t: "toast"; level: "info" | "warn" | "error"; text: string };

/* ---------- HTTP bodies (client → server) ---------- */

export interface SetBrightnessBody { brightness: number }
export interface SetVolumeBody { volume: number }
export interface RecallPresetBody { presetId: number }
export interface SetBlackoutBody { blackout: boolean }
export interface SetOnBody { on: boolean }
export interface SetPowerStateBody { state: "on" | "blackout" | "standby" }
export interface SetGroupStateBody { state: PowerTarget }
export interface SaveGroupsBody { groups: GroupConfig[] }
export interface SnoozeBody { hours?: number; clear?: boolean }
export interface ApiError { error: string }
