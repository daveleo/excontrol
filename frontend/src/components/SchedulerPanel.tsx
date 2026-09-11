import { useState } from "react";
import type { AppState, Schedule, ScheduleEntry, ScheduleAction } from "@excontrol/shared";
import { Modal } from "./Modal.js";
import { saveSchedule, verifyToken } from "../api.js";
import { ensureUnlocked } from "../lib/unlock.js";

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function blank(): ScheduleEntry {
  return { id: "", label: "Power off", time: "17:00", days: [], action: "power_off", target: "all", enabled: true };
}

export function SchedulerPanel({ state, onClose }: { state: AppState; onClose: () => void }) {
  const [entries, setEntries] = useState<ScheduleEntry[]>(state.schedule.entries);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const epsIds = state.devices.filter((d) => d.type === "expromo-eps").map((d) => d.id);

  const patch = (i: number, p: Partial<ScheduleEntry>) =>
    setEntries((es) => es.map((e, idx) => (idx === i ? { ...e, ...p } : e)));
  const toggleDay = (i: number, d: number) =>
    setEntries((es) =>
      es.map((e, idx) =>
        idx === i ? { ...e, days: e.days.includes(d) ? e.days.filter((x) => x !== d) : [...e.days, d].sort() } : e,
      ),
    );

  const save = async () => {
    if (!(await ensureUnlocked(state.app.settingsLocked, verifyToken))) return;
    setSaving(true);
    try {
      const res = (await saveSchedule(entries)) as Schedule;
      setEntries(res.entries);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Scheduler" onClose={onClose}>
      <p className="modal-lead">Automatically power on/off, or apply a preset, at a set time.</p>

      {entries.length === 0 && <p className="hint muted">No schedules yet.</p>}

      {entries.map((e, i) => (
        <div key={i} className="sched-row">
          <div className="sched-line1">
            <label className="toggle">
              <input type="checkbox" checked={e.enabled} onChange={(ev) => patch(i, { enabled: ev.target.checked })} />
            </label>
            <input className="sched-time" type="time" value={e.time} onChange={(ev) => patch(i, { time: ev.target.value })} />
            <select
              value={e.action}
              onChange={(ev) => patch(i, { action: ev.target.value as ScheduleAction })}
            >
              <option value="power_off">Power OFF</option>
              <option value="power_on">Power ON</option>
              <option value="apply_preset">Apply preset</option>
            </select>
            {e.action === "apply_preset" ? (
              <select value={e.presetId ?? ""} onChange={(ev) => patch(i, { presetId: ev.target.value || undefined })}>
                <option value="">— preset —</option>
                {state.presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            ) : epsIds.length > 1 ? (
              <select value={e.target ?? "all"} onChange={(ev) => patch(i, { target: ev.target.value })}>
                <option value="all">All power units</option>
                {epsIds.map((id) => {
                  const d = state.devices.find((x) => x.id === id)!;
                  return <option key={id} value={id}>{d.label}</option>;
                })}
              </select>
            ) : null}
            <input className="sched-label" value={e.label} placeholder="Label" onChange={(ev) => patch(i, { label: ev.target.value })} />
            <button className="icon-btn" aria-label="Remove" onClick={() => setEntries((es) => es.filter((_, x) => x !== i))}>✕</button>
          </div>
          <div className="sched-days">
            {DAYS.map((d, di) => (
              <button key={di} type="button" className={e.days.includes(di) ? "day on" : "day"} onClick={() => toggleDay(i, di)}>
                {d}
              </button>
            ))}
            <span className="hint muted">{e.days.length === 0 ? "every day" : ""}</span>
          </div>
        </div>
      ))}

      <div className="modal-actions">
        <button onClick={() => setEntries((es) => [...es, blank()])}>+ Add schedule</button>
        <button className="primary" disabled={saving} onClick={save}>
          {saved ? "Saved ✓" : saving ? "Saving…" : "Save"}
        </button>
      </div>

      {state.schedule.lastRun && (
        <p className="hint muted">
          Last run: {state.schedule.lastRun.action.replace("_", " ")} at{" "}
          {new Date(state.schedule.lastRun.at).toLocaleString()}
        </p>
      )}
    </Modal>
  );
}
