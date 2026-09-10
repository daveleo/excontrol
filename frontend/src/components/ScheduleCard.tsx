import { useState } from "react";
import type { Schedule } from "@excontrol/shared";
import { effectiveShutdown, nextPowerOn, humanDuration, humanWhen } from "@excontrol/shared";
import { useNow } from "../lib/useNow.js";
import { snoozeShutdown, cancelShutdownExtension } from "../api.js";

const IMMINENT_MS = 15 * 60 * 1000;

export function ScheduleCard({ schedule }: { schedule: Schedule }) {
  const now = useNow(1000);
  const [busy, setBusy] = useState(false);

  const shutdown = effectiveShutdown(schedule, now);
  const powerOn = nextPowerOn(schedule, now);
  const extended = (shutdown?.extendedHours ?? 0) > 0;
  const msToShutdown = shutdown ? shutdown.at.getTime() - now.getTime() : Infinity;
  const imminent = msToShutdown <= IMMINENT_MS;

  const act = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    try { await fn(); } catch { /* toast */ } finally { setBusy(false); }
  };

  const hasSchedule = schedule.entries.some((e) => e.enabled);
  if (!hasSchedule && !shutdown) {
    return (
      <section className="card" data-status="online">
        <div className="card-head"><h2>Scheduler</h2><span className="status online">0 active</span></div>
        <p className="hint muted">No schedules. Open the ⏰ menu to add one.</p>
      </section>
    );
  }

  return (
    <section className="card" data-status="online">
      <div className="card-head">
        <h2>Scheduler</h2>
        <span className="status online">{schedule.entries.filter((e) => e.enabled).length} active</span>
      </div>

      <div className="sched-metrics">
        <div className="metric">
          <span className="metric-label">
            Time until shutdown
            {extended && <span className="ext-tag"> (Extended +{shutdown!.extendedHours}h)</span>}
          </span>
          <span className={`metric-value ${imminent ? "warn" : ""}`}>
            {shutdown ? humanDuration(msToShutdown) : "Not scheduled"}
          </span>
          {shutdown && (
            <span className={`metric-sub ${extended ? "ext-tag" : ""}`}>at {humanWhen(shutdown.at, now)}</span>
          )}
        </div>
        <div className="metric">
          <span className="metric-label">Next scheduled power-on</span>
          <span className="metric-value">{powerOn ? humanWhen(powerOn, now) : "Not scheduled"}</span>
        </div>
      </div>

      {shutdown && (
        <div className="sched-actions">
          <button disabled={busy} onClick={act(() => snoozeShutdown(1))}>
            {extended ? "+ 1 more hour" : "Extend shutdown by 1 hour"}
          </button>
          {extended && <button disabled={busy} onClick={act(cancelShutdownExtension)}>Cancel extension</button>}
        </div>
      )}
    </section>
  );
}
