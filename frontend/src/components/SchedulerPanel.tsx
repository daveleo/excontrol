import { useEffect, useMemo, useRef, useState } from "react";
import type { AppState, Schedule, ScheduleEntry, ScheduleAction } from "@excontrol/shared";
import { Modal } from "./Modal.js";
import { saveSchedule, verifyToken } from "../api.js";
import { ensureUnlocked } from "../lib/unlock.js";
import { describeEntry, scheduleTargetLabel } from "../lib/targets.js";

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // show Monday first
const FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Every day", "Weekdays", "Every day except Fr", "Mo, We, Fr" */
export function daysPhrase(days: number[]): string {
  const set = new Set(days);
  if (set.size === 0 || set.size === 7) return "Every day";
  const is = (xs: number[]) => xs.length === set.size && xs.every((x) => set.has(x));
  if (is([1, 2, 3, 4, 5])) return "Weekdays";
  if (is([0, 6])) return "Weekends";
  if (set.size === 6) return `Every day except ${DAYS[DAY_ORDER.find((d) => !set.has(d))!]}`;
  if (set.size === 1) return `${FULL[[...set][0]!]}s`;
  return DAY_ORDER.filter((d) => set.has(d)).map((d) => DAYS[d]).join(", ");
}

function blank(): ScheduleEntry {
  return { id: "", label: "", time: "17:00", days: [1, 2, 3, 4, 5], action: "power_off", target: "all", enabled: true };
}

/**
 * Each entry reads as a sentence and saves itself — no Save button to forget; Undo steps
 * back through what was saved. A week strip underneath shows what will actually happen.
 */
export function SchedulerPanel({ state, onClose }: { state: AppState; onClose: () => void }) {
  const [entries, setEntries] = useState<ScheduleEntry[]>(state.schedule.entries);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const history = useRef<ScheduleEntry[][]>([]);
  const lastSaved = useRef<ScheduleEntry[]>(state.schedule.entries);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const unlocked = useRef(!state.app.settingsLocked);

  const groups = (state.groups ?? []).filter((g) => g.id !== "all");
  const epsUnits = state.devices.filter((d) => d.type === "expromo-eps");

  const persist = async (next: ScheduleEntry[], pushHistory = true) => {
    if (!unlocked.current) {
      unlocked.current = await ensureUnlocked(state.app.settingsLocked, verifyToken);
      if (!unlocked.current) return;
    }
    setStatus("saving");
    setErr(null);
    try {
      const labelled = next.map((e) => ({ ...e, label: describeEntry(state, e) }));
      const res = (await saveSchedule(labelled)) as Schedule;
      if (pushHistory) history.current.push(lastSaved.current);
      lastSaved.current = res.entries;
      setEntries((cur) => res.entries.map((e, i) => ({ ...e, id: e.id || cur[i]?.id || "" })));
      setStatus("saved");
    } catch (e) {
      setStatus("error");
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  // autosave, debounced — typing a time shouldn't save every keystroke
  const change = (next: ScheduleEntry[]) => {
    setEntries(next);
    setStatus("idle");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void persist(next), 700);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const undo = async () => {
    const prev = history.current.pop();
    if (!prev) return;
    setEntries(prev);
    await persist(prev, false);
  };

  const patch = (i: number, p: Partial<ScheduleEntry>) => change(entries.map((e, x) => (x === i ? { ...e, ...p } : e)));
  const toggleDay = (i: number, d: number) => {
    const e = entries[i]!;
    const days = e.days.length === 0 ? [0, 1, 2, 3, 4, 5, 6] : e.days;
    const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d];
    patch(i, { days: next.length === 7 ? [] : next.sort() });
  };

  return (
    <Modal title="Schedule" onClose={onClose} wide>
      <div className="sch-status">
        <span className={`muted small ${status === "error" ? "err" : ""}`}>
          {status === "saving" ? "Saving…" : status === "saved" ? "Saved" : status === "error" ? err : "Changes save automatically"}
        </span>
        {history.current.length > 0 && <button className="linkish" onClick={() => void undo()}>Undo</button>}
      </div>

      {entries.length === 0 && <p className="hint muted">Nothing scheduled yet.</p>}

      {entries.map((e, i) => (
        <div key={e.id || `new-${i}`} className={`sch-row ${e.enabled ? "" : "disabled"}`}>
          <div className="sch-sentence">
            <label className="switch" title={e.enabled ? "On — tap to pause this entry" : "Paused"}>
              <input type="checkbox" checked={e.enabled} onChange={(ev) => patch(i, { enabled: ev.target.checked })} />
              <span />
            </label>
            <span className="sch-days">{daysPhrase(e.days)}</span>
            <span className="muted">at</span>
            <input className="sch-time" type="time" value={e.time} onChange={(ev) => patch(i, { time: ev.target.value })} />
            <select value={e.action} onChange={(ev) => patch(i, { action: ev.target.value as ScheduleAction })}>
              <option value="power_off">turn off</option>
              <option value="standby">standby</option>
              <option value="power_on">turn on</option>
              <option value="apply_preset">apply scene</option>
            </select>
            {e.action === "apply_preset" ? (
              <select value={e.presetId ?? ""} onChange={(ev) => patch(i, { presetId: ev.target.value || undefined })}>
                <option value="">— scene —</option>
                {state.presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            ) : (
              <select value={e.target ?? "all"} onChange={(ev) => patch(i, { target: ev.target.value })}>
                <option value="all">{scheduleTargetLabel(state, "all")}</option>
                {groups.map((g) => <option key={g.id} value={`group:${g.id}`}>{g.label}</option>)}
                {e.action !== "standby" && epsUnits.map((d) => <option key={d.id} value={d.id}>{d.label} (power unit)</option>)}
              </select>
            )}
            <button className="icon-btn sch-x" aria-label="Remove" onClick={() => change(entries.filter((_, x) => x !== i))}>✕</button>
          </div>
          <div className="sch-daypick">
            {DAY_ORDER.map((d) => (
              <button
                key={d} type="button"
                className={e.days.length === 0 || e.days.includes(d) ? "day on" : "day"}
                onClick={() => toggleDay(i, d)}
              >
                {DAYS[d]}
              </button>
            ))}
          </div>
        </div>
      ))}

      <div className="modal-actions">
        <button onClick={() => change([...entries, blank()])}>+ Add</button>
      </div>

      <WeekStrip state={state} entries={entries} />
    </Modal>
  );
}

/** The next seven days, and what happens on each. */
function WeekStrip({ state, entries }: { state: AppState; entries: ScheduleEntry[] }) {
  const days = useMemo(() => {
    const out: { label: string; items: { time: string; text: string }[] }[] = [];
    const now = new Date();
    for (let k = 0; k < 7; k++) {
      const d = new Date(now);
      d.setDate(d.getDate() + k);
      const dow = d.getDay();
      const items = entries
        .filter((e) => e.enabled && (e.days.length === 0 || e.days.includes(dow)))
        .filter((e) => k > 0 || e.time > `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`)
        .sort((a, b) => a.time.localeCompare(b.time))
        .map((e) => ({ time: e.time, text: describeEntry(state, e) }));
      out.push({ label: k === 0 ? "Today" : k === 1 ? "Tomorrow" : d.toLocaleDateString([], { weekday: "short" }), items });
    }
    return out;
  }, [state, entries]);
  return (
    <div className="week">
      <div className="dc-label">The next 7 days</div>
      <div className="week-grid">
        {days.map((d) => (
          <div key={d.label} className="week-day">
            <b>{d.label}</b>
            {d.items.length === 0 ? <span className="muted small">—</span> : d.items.map((it, j) => (
              <span key={j} className="small"><span className="week-time">{it.time}</span> {it.text}</span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
