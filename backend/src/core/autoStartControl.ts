/**
 * Lets the Settings-panel route apply an "autostart" change to the OS without http.ts
 * needing to know Electron exists — same registration pattern as httpControl.ts. The
 * backend has no idea what a Windows login item is; Electron's main process registers the
 * handler that actually calls `app.setLoginItemSettings()`.
 */
type AutoStartHandler = (enabled: boolean) => void;

let handler: AutoStartHandler | null = null;

export function registerAutoStartHandler(fn: AutoStartHandler | null): void {
  handler = fn;
}

/** No-op outside Electron (running from source / the CLI) — the setting still persists in
 *  config either way, it just has nothing to apply to the OS. */
export function notifyAutoStartChanged(enabled: boolean): void {
  handler?.(enabled);
}
