import type {
  AppPreset, ScheduleEntry, SetupState, SetupDevice, SetupSaveBody, SetupSaveResponse,
  ProbeResult, ScanHit, AuthStatus, SetPasswordBody,
} from "@excontrol/shared";
import { getToken, setToken, clearToken } from "./lib/auth.js";

const ZONE = (z?: string) => z || "-"; // "-" => the device's first/only zone

export const setBrightness = (id: string, zoneId: string | undefined, brightness: number) =>
  post(`/api/devices/${id}/zones/${ZONE(zoneId)}/brightness`, { brightness });

export const recallPreset = (id: string, zoneId: string | undefined, presetId: number) =>
  post(`/api/devices/${id}/zones/${ZONE(zoneId)}/preset`, { presetId });

export const setBlackout = (id: string, zoneId: string | undefined, blackout: boolean) =>
  post(`/api/devices/${id}/zones/${ZONE(zoneId)}/blackout`, { blackout });

export const runAction = (id: string, name: string) =>
  post(`/api/devices/${id}/action/${name}`, {}).then((r) => String((r as { result?: unknown }).result ?? ""));

export const power = (target: string, on: boolean) => post(`/api/power/${target}/${on ? "on" : "off"}`, {});

export const savePreset = (p: Partial<AppPreset> & { label: string }) =>
  post("/api/presets", p) as Promise<AppPreset>;
export const deletePreset = (id: string) => del(`/api/presets/${id}`);
export const applyPreset = (id: string) => post(`/api/presets/${id}/apply`, {});

export const saveSchedule = (entries: ScheduleEntry[]) => put("/api/schedule", { entries });
export const snoozeShutdown = (hours: number) => post("/api/schedule/snooze", { hours });
export const cancelShutdownExtension = () => post("/api/schedule/snooze", { clear: true });
export const setUpdatesPaused = (paused: boolean) => post("/api/updates/pause", { paused });

/* ---- setup wizard ---- */
export const getSetupState = () => send("GET", "/api/setup/state") as Promise<SetupState>;
export const probeDevice = (d: SetupDevice) => post("/api/setup/probe", d) as Promise<ProbeResult>;
export const scanNetwork = () =>
  send("GET", "/api/setup/scan") as Promise<{ subnets: string[]; hits: ScanHit[] }>;
export const saveSetup = (body: SetupSaveBody) => post("/api/setup/save", body) as Promise<SetupSaveResponse>;

/* ---- settings lock ---- */
export const authStatus = () => send("GET", "/api/auth/status") as Promise<AuthStatus>;
export async function login(password: string): Promise<void> {
  const { token } = (await post("/api/auth/login", { password })) as { token: string };
  setToken(token);
}
export async function verifyToken(): Promise<boolean> {
  if (!getToken()) return false;
  try {
    const { valid } = (await send("GET", "/api/auth/verify")) as { valid: boolean };
    return valid;
  } catch {
    return false;
  }
}
export async function setSettingsPassword(body: SetPasswordBody): Promise<void> {
  await post("/api/auth/set-password", body);
  if (!body.newPassword) clearToken(); // lock removed — nothing to hold a token for
}

const post = (url: string, body: unknown) => send("POST", url, body);
const put = (url: string, body: unknown) => send("PUT", url, body);
const del = (url: string) => send("DELETE", url);

async function send(method: string, url: string, body?: unknown): Promise<unknown> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(url, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json;
}
