import { useState } from "react";
import type { PowerAlert } from "@excontrol/shared";
import { dismissAlert } from "../api.js";

/** "eXview turned On after it was set to Off (Schedule: Power off, 17:00)" — the engine
 *  reports it rather than fighting it; this makes sure someone actually sees it. */
export function AlertPopup({ alerts }: { alerts: PowerAlert[] }) {
  const [busy, setBusy] = useState(false);
  if (!alerts.length) return null;
  const a = alerts[0]!;
  const dismiss = async (id: string) => {
    setBusy(true);
    try { await dismissAlert(id); } catch { /* ignore */ } finally { setBusy(false); }
  };
  return (
    <div className="alert-pop" role="alertdialog" aria-live="assertive">
      <div className="alert-title">Turned on after its scheduled off</div>
      <div className="alert-text">{a.text}</div>
      <div className="alert-meta">
        {new Date(a.at).toLocaleString([], { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })}
        {alerts.length > 1 && ` · ${alerts.length - 1} more`}
      </div>
      <div className="alert-actions">
        <button disabled={busy} onClick={() => void dismiss(a.id)}>Dismiss</button>
        {alerts.length > 1 && <button disabled={busy} onClick={() => void dismiss("all")}>Dismiss all</button>}
      </div>
    </div>
  );
}
