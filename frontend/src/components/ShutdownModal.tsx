import { useEffect, useRef, useState } from "react";
import type { Schedule } from "@excontrol/shared";
import { effectiveShutdown, mmss } from "@excontrol/shared";
import { useNow } from "../lib/useNow.js";
import { snoozeShutdown } from "../api.js";

const IMMINENT_MS = 15 * 60 * 1000;

/** Full-screen warning in the last 15 minutes before an auto power-off. Dismissible. */
export function ShutdownModal({ schedule }: { schedule: Schedule }) {
  const now = useNow(1000);
  const [busy, setBusy] = useState(false);
  const [dismissedFor, setDismissedFor] = useState<number | null>(null);
  const lastTarget = useRef<number | null>(null);

  const shutdown = effectiveShutdown(schedule, now);
  const target = shutdown ? shutdown.at.getTime() : null;
  const msLeft = target ? target - now.getTime() : Infinity;

  useEffect(() => {
    if (target !== lastTarget.current) {
      lastTarget.current = target;
      setDismissedFor(null);
    }
  }, [target]);

  const show = target != null && msLeft <= IMMINENT_MS && msLeft > 0 && dismissedFor !== target;
  if (!show || target == null) return null;

  const extend = async () => {
    setBusy(true);
    try { await snoozeShutdown(1); } catch { /* toast */ } finally { setBusy(false); }
  };

  return (
    <div className="modal-scrim">
      <div className="modal shutdown-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sd-title">Powering off</div>
        <div className="sd-countdown">{mmss(msLeft)}</div>
        <div className="sd-sub">at {new Date(target).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
        <button className="sd-extend" disabled={busy} onClick={extend}>Extend by 1 hour</button>
        <p className="sd-hint">Press again from the Scheduler card to add more hours.</p>
        <button className="sd-dismiss" onClick={() => setDismissedFor(target)}>Dismiss — let it power off</button>
      </div>
    </div>
  );
}
