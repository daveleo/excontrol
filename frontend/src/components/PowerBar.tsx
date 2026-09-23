import { useEffect, useState } from "react";
import type { AppState, PowerTarget } from "@excontrol/shared";
import { ALL_GROUP, effectiveShutdown, nextPowerOn, humanDuration } from "@excontrol/shared";
import { setGroupState, snoozeShutdown, cancelShutdownExtension } from "../api.js";
import { useNow } from "../lib/useNow.js";
import { roomStatus, faults, hhmm, whenPhrase } from "../lib/status.js";
import { scheduleTargetLabel } from "../lib/targets.js";

/**
 * The room, in one place: its state in one word, one primary action that says what it
 * will do, Standby beside it, and the next scheduled change with "+1 hour". Replaces the
 * old red EPS banner, the Everything card and the Scheduler card.
 */
export function PowerBar({ state }: { state: AppState }) {
  const now = useNow(1000);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState<PowerTarget | null>(null);
  const rs = roomStatus(state);
  const all = state.groups?.find((g) => g.id === ALL_GROUP);
  const isOn = rs.tone === "on" || (all?.busy && all.target === "on");
  const primary: PowerTarget = isOn ? "off" : "on";

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(null), 3500);
    return () => clearTimeout(t);
  }, [armed]);

  const go = async (t: PowerTarget) => {
    // Turning the whole room off or to standby asks for a second tap.
    if (t !== "on" && armed !== t) return setArmed(t);
    setArmed(null);
    setBusy(true);
    try { await setGroupState(ALL_GROUP, t); } catch { /* toast */ } finally { setBusy(false); }
  };
  const act = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    try { await fn(); } catch { /* toast */ } finally { setBusy(false); }
  };

  const shutdown = effectiveShutdown(state.schedule, now);
  const powerOn = nextPowerOn(state.schedule, now);
  const extended = (shutdown?.extendedHours ?? 0) > 0;
  const since = all?.setAt && all.target ? `since ${hhmm(all.setAt)} · ${sourceOf(all.setBy)}` : "";
  const fault = faults(state);

  const label = (t: PowerTarget) =>
    armed === t ? (t === "off" ? "Tap again to turn off" : "Tap again for standby") : t === "on" ? "Turn on" : t === "off" ? "Turn off" : "Standby";

  return (
    <section className={`power-bar tone-${rs.tone}`} aria-label={`${rs.name} power`}>
      <div className="pbar-main">
        <div className="pbar-room">{rs.name}</div>
        <div className="pbar-state">
          <span className={`sdot ${rs.tone}`} aria-hidden />
          {rs.word}
        </div>
        {rs.detail
          ? <div className="pbar-sub warn"><span className="pb-spinner small" aria-hidden />{rs.detail}</div>
          : since && <div className="pbar-sub">{since}</div>}
      </div>
      <div className="pbar-actions">
        <button className={`pbar-btn ${armed === "standby" ? "armed" : ""}`} disabled={busy} onClick={() => void go("standby")}>
          {label("standby")}
        </button>
        <button
          className={`pbar-btn ${primary === "on" ? "go" : ""} ${armed === "off" ? "armed" : ""}`}
          disabled={busy}
          onClick={() => void go(primary)}
        >
          {label(primary)}
        </button>
      </div>

      <div className="pbar-next">
        {shutdown && (isOn || !powerOn || shutdown.at.getTime() < powerOn.getTime()) ? (
          <>
            <span>
              {shutdown.entry?.action === "standby" ? "Goes to standby" : "Turns off"} <b>{whenPhrase(shutdown.at, now)}</b>
              {shutdown.entry && shutdown.entry.target && shutdown.entry.target !== "all" && <> · {scheduleTargetLabel(state, shutdown.entry.target)}</>}
              {" · "}in {humanDuration(shutdown.at.getTime() - now.getTime())}
              {extended && <span className="pbar-ext"> · extended +{shutdown.extendedHours} h</span>}
            </span>
            <span className="pbar-next-actions">
              {extended && <button className="linkish" disabled={busy} onClick={act(cancelShutdownExtension)}>Undo extension</button>}
              <button className="pbar-small" disabled={busy} onClick={act(() => snoozeShutdown(1))}>+1 hour</button>
            </span>
          </>
        ) : powerOn ? (
          <span>Turns on <b>{whenPhrase(powerOn, now)}</b></span>
        ) : (
          <span className="muted">Nothing scheduled</span>
        )}
      </div>

      {fault.length > 0 && (
        <div className="pbar-fault">
          <span className="sdot fault" aria-hidden />
          {fault.join(", ")} {fault.length === 1 ? "isn't" : "aren't"} responding
        </div>
      )}
    </section>
  );
}

function sourceOf(setBy?: string): string {
  if (!setBy) return "";
  if (setBy.startsWith("Schedule")) return "by schedule";
  if (setBy === "Dashboard") return "set by hand";
  return `by ${setBy}`;
}
