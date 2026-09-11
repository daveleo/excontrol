/**
 * First-run setup wizard contract. The wizard is a device editor: it reads the current
 * config (secrets redacted), lets the operator add/edit/remove devices and zones, tests
 * each connection, and writes the config back.
 */
import type { DeviceType } from "./index.js";

/** Sentinel the server sends in place of a stored secret, and accepts back to mean "keep it". */
export const SECRET_KEPT = "••••••••";

/** A zone as the wizard edits it. */
export interface SetupZone {
  id: string;
  label: string;
  /** H-series: a screen number. COEX: the screen GUID (blank ⇒ discover on connect). */
  screenId: number | string;
  deviceId?: number;
}

/** One device as the wizard edits it — a flattened superset of every device type's config. */
export interface SetupDevice {
  id: string;
  type: DeviceType;
  label: string;
  enabled: boolean;
  host: string;
  port: number;
  poweredBy?: string | null;
  /** H-series */
  pId?: string;
  secretKey?: string; // may be SECRET_KEPT
  encrypted?: boolean;
  /** OBS */
  password?: string; // may be SECRET_KEPT
  /** H-series / COEX */
  zones?: SetupZone[];
}

export interface SetupState {
  configured: boolean;
  app: { name: string; httpPort: number; bind: string };
  /** true → this endpoint itself required a password to reach; shown so the wizard can
   *  offer "change" instead of "set" for the settings password. */
  settingsLocked: boolean;
  devices: SetupDevice[];
  /** default port per device type, for pre-filling a new device */
  defaultPorts: Record<DeviceType, number>;
}

export interface SetupSaveBody {
  app?: Partial<{ name: string; httpPort: number; bind: string }>;
  devices: SetupDevice[];
}

export interface SetupSaveResponse {
  ok: boolean;
  configured: boolean;
  /** the HTTP port changed — the server rebinds itself and the client must follow it */
  portChanged: boolean;
  port: number;
}

/** What a probe found. `ok` drives the green/red state; `detail` is the human line. */
export interface ProbeResult {
  ok: boolean;
  detail: string;
  /** machine-readable classification for the wizard */
  hint?: "ok" | "unreachable" | "auth" | "disabled" | "misconfigured" | "booting" | "bad-response";
  /** extra info line shown on success (EPS label, OBS version, …) */
  info?: string;
  /** zones/screens/scenes discovered on success */
  zones?: SetupZone[];
}

/** A host that answered on the subnet scan. */
export interface ScanHit {
  host: string;
  port: number;
  guess: DeviceType;
}
