/**
 * Update-checker contract. electron-updater lives entirely in the Electron main process
 * (the backend has no concept of GitHub Releases and runs fine standalone without it) —
 * main.ts pushes what it learns in here so every connected browser, not just the control
 * PC's own window, can see "an update is available".
 */
export interface UpdateInfo {
  available: boolean;
  /** the newer version, when available */
  version?: string;
  currentVersion: string;
  /** the GitHub Releases page, for a human to go look */
  url: string;
  notes?: string;
  checkedAt: number;
  /** set when the last check itself failed (network, no releases yet, …) */
  error?: string;
}

export interface UpdateStatusBody {
  available: boolean;
  version?: string;
  notes?: string;
  error?: string;
}

/** Response to a manual "check for updates" request from Settings. `triggered` is false
 *  when there's no Electron updater in this runtime (running from source / the CLI) —
 *  the result of the check itself still arrives later via the usual `updateInfo` broadcast. */
export interface UpdateCheckResponse {
  ok: boolean;
  triggered: boolean;
}
