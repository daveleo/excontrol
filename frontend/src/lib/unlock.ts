/**
 * A tiny singleton so any component (PresetsPanel, SchedulerPanel, App's Devices button)
 * can ask "is the settings password satisfied?" without prop-drilling a modal through the
 * tree. `UnlockModal` (mounted once in App) calls `registerUnlockUI` and does the actual
 * prompting; everyone else just awaits `requestUnlock()`.
 */
type Waiter = (ok: boolean) => void;
let waiters: Waiter[] = [];
let openSetter: ((open: boolean) => void) | null = null;

export function registerUnlockUI(setOpen: (open: boolean) => void): void {
  openSetter = setOpen;
}

export function requestUnlock(): Promise<boolean> {
  return new Promise((resolve) => {
    waiters.push(resolve);
    openSetter?.(true);
  });
}

export function resolveUnlock(ok: boolean): void {
  const pending = waiters;
  waiters = [];
  openSetter?.(false);
  pending.forEach((w) => w(ok));
}

/** Call before any settings-gated action. No-ops (returns true) when nothing is locked,
 *  or immediately when a stored token still verifies — only prompts as a last resort. */
export async function ensureUnlocked(locked: boolean, verify: () => Promise<boolean>): Promise<boolean> {
  if (!locked) return true;
  if (await verify()) return true;
  return requestUnlock();
}
