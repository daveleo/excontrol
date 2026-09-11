import { useState } from "react";
import type { UpdateInfo } from "@excontrol/shared";

const DISMISS_KEY = "excontrol.updateDismissed";

/**
 * Shown on every open screen, not just the control PC's own window — a phone can't install
 * the update, but whoever's holding it should know one is waiting at the control PC.
 */
export function UpdateBanner({ info }: { info: UpdateInfo }) {
  const [dismissedVersion, setDismissedVersion] = useState(() => localStorage.getItem(DISMISS_KEY));
  if (!info.available || !info.version || info.version === dismissedVersion) return null;

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, info.version!); } catch { /* private mode etc. */ }
    setDismissedVersion(info.version!);
  };

  return (
    <div className="update-banner">
      <span>
        <b>eXcontrol {info.version}</b> is available (you have {info.currentVersion}). Update from the control PC's tray icon.
      </span>
      <div className="row">
        <a href={info.url} target="_blank" rel="noreferrer">What's new</a>
        <button onClick={dismiss}>Dismiss</button>
      </div>
    </div>
  );
}
