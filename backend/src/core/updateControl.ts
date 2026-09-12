/**
 * Lets the Settings panel trigger an update check from the web UI, without http.ts needing
 * a reference to electron-updater — same registration pattern as httpControl.ts /
 * autoStartControl.ts. Electron's main process registers the handler that actually calls
 * `autoUpdater.checkForUpdates()`; the result arrives later via the usual
 * `POST /api/internal/update-status` -> `AppState.updateInfo` broadcast, same as the
 * automatic on-launch check.
 */
type UpdateChecker = (manual: boolean) => void;

let checker: UpdateChecker | null = null;

export function registerUpdateChecker(fn: UpdateChecker | null): void {
  checker = fn;
}

/** Returns false (and does nothing) outside Electron — running from source / the CLI has
 *  no updater to check. */
export function requestUpdateCheck(manual: boolean): boolean {
  if (!checker) return false;
  checker(manual);
  return true;
}
