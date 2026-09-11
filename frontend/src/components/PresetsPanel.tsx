import { useMemo, useState } from "react";
import type { AppState, AppPreset, PresetAction, DeviceState } from "@excontrol/shared";
import { ALWAYS_ON_DOMAIN } from "@excontrol/shared";
import { Modal } from "./Modal.js";
import { savePreset, deletePreset, applyPreset, verifyToken } from "../api.js";
import { ensureUnlocked } from "../lib/unlock.js";

/** A target row the editor can toggle on/off. */
interface Row {
  key: string;           // "deviceId" or "deviceId:zoneId"
  label: string;
  kind: "zone" | "obs" | "eps";
  device: DeviceState;
  zoneId?: string;
  presetOptions: { id: number; name: string }[];
}

function buildRows(state: AppState): Row[] {
  const rows: Row[] = [];
  for (const d of state.devices) {
    if (d.type === "expromo-eps") {
      rows.push({ key: d.id, label: `${d.label} — power`, kind: "eps", device: d, presetOptions: [] });
    } else if (d.type === "obs") {
      const z = d.zones[0];
      rows.push({
        key: d.id,
        label: `${d.label} — scene`,
        kind: "obs",
        device: d,
        zoneId: z?.id,
        presetOptions: z?.presets ?? [],
      });
    } else {
      for (const z of d.zones) {
        rows.push({
          key: `${d.id}:${z.id}`,
          label: d.zones.length > 1 ? `${d.label} · ${z.label}` : d.label,
          kind: "zone",
          device: d,
          zoneId: z.id,
          presetOptions: z.presets ?? [],
        });
      }
    }
  }
  return rows;
}

export function PresetsPanel({ state, onClose }: { state: AppState; onClose: () => void }) {
  const [editing, setEditing] = useState<AppPreset | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const act = (fn: () => Promise<unknown>, key: string) => async () => {
    setBusy(key);
    try { await fn(); } catch { /* toast */ } finally { setBusy(null); }
  };

  const edit = async (p: AppPreset | "new") => {
    if (!(await ensureUnlocked(state.app.settingsLocked, verifyToken))) return;
    setEditing(p);
  };
  const remove = async (id: string) => {
    if (!(await ensureUnlocked(state.app.settingsLocked, verifyToken))) return;
    await act(() => deletePreset(id), id)();
  };

  if (editing) {
    return (
      <PresetEditor
        state={state}
        preset={editing === "new" ? null : editing}
        onClose={() => setEditing(null)}
        onDone={() => setEditing(null)}
      />
    );
  }

  return (
    <Modal title="Presets" onClose={onClose}>
      <p className="modal-lead">
        A preset is a saved look — brightness, presets, blackout and OBS scene across your
        devices. Apply it with one tap, or set it as the power-on default.
      </p>

      {state.presets.length === 0 && <p className="hint muted">No presets yet.</p>}

      {state.presets.map((p) => (
        <div key={p.id} className="preset-row">
          <div className="pr-main">
            <b>{p.label}</b>
            <span className="pr-meta">
              {p.actions.length} action{p.actions.length === 1 ? "" : "s"}
              {p.powerOnDefaultFor ? ` · power-on default` : ""}
            </span>
          </div>
          <div className="row">
            <button className="primary" disabled={busy === p.id} onClick={act(() => applyPreset(p.id), p.id)}>
              Apply
            </button>
            <button disabled={busy === p.id} onClick={() => void edit(p)}>Edit</button>
            <button disabled={busy === p.id} onClick={() => void remove(p.id)}>Delete</button>
          </div>
        </div>
      ))}

      <div className="modal-actions">
        <button onClick={() => void edit("new")}>+ New preset</button>
      </div>
    </Modal>
  );
}

function PresetEditor({
  state,
  preset,
  onClose,
  onDone,
}: {
  state: AppState;
  preset: AppPreset | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const rows = useMemo(() => buildRows(state), [state]);
  const [label, setLabel] = useState(preset?.label ?? "");
  const [powerOn, setPowerOn] = useState<string>(preset?.powerOnDefaultFor ?? "");
  const [saving, setSaving] = useState(false);

  // seed per-row action state from the existing preset
  const seed: Record<string, PresetAction> = {};
  for (const a of preset?.actions ?? []) seed[a.target] = a;
  const [actions, setActions] = useState<Record<string, PresetAction>>(seed);

  const toggle = (key: string, on: boolean) =>
    setActions((s) => {
      const next = { ...s };
      if (on) next[key] = next[key] ?? { target: key };
      else delete next[key];
      return next;
    });
  const patch = (key: string, p: Partial<PresetAction>) =>
    setActions((s) => ({ ...s, [key]: { ...(s[key] ?? { target: key }), ...p } }));

  const save = async () => {
    setSaving(true);
    try {
      await savePreset({
        id: preset?.id,
        label: label.trim() || "Preset",
        actions: Object.values(actions),
        powerOnDefaultFor: powerOn || null,
      });
      onDone();
    } finally {
      setSaving(false);
    }
  };

  const epsIds = state.devices.filter((d) => d.type === "expromo-eps").map((d) => d.id);

  return (
    <Modal title={preset ? "Edit preset" : "New preset"} onClose={onClose}>
      <label className="field">
        <span>Name</span>
        <input className="sched-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Daytime" />
      </label>

      <div className="section-label">What it sets</div>
      {rows.map((r) => {
        const on = r.key in actions;
        const a = actions[r.key];
        return (
          <div key={r.key} className={`pe-row ${on ? "on" : ""}`}>
            <label className="toggle">
              <input type="checkbox" checked={on} onChange={(e) => toggle(r.key, e.target.checked)} />
              {r.label}
            </label>
            {on && r.kind === "zone" && (
              <div className="pe-controls">
                <label>
                  Brightness
                  <input
                    type="range" min={0} max={100}
                    value={a?.brightness ?? 50}
                    onChange={(e) => patch(r.key, { brightness: Number(e.target.value) })}
                  />
                  <b>{a?.brightness ?? 50}%</b>
                </label>
                <select
                  value={a?.preset ?? ""}
                  onChange={(e) => patch(r.key, { preset: e.target.value === "" ? undefined : Number(e.target.value) })}
                >
                  <option value="">— preset: leave —</option>
                  {r.presetOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={a?.blackout ?? false}
                    onChange={(e) => patch(r.key, { blackout: e.target.checked })}
                  />
                  Blackout
                </label>
              </div>
            )}
            {on && r.kind === "obs" && (
              <select value={a?.scene ?? ""} onChange={(e) => patch(r.key, { scene: e.target.value || undefined })}>
                <option value="">— scene: leave —</option>
                {r.presetOptions.map((o) => <option key={o.id} value={o.name}>{o.name}</option>)}
              </select>
            )}
            {on && r.kind === "eps" && (
              <select value={a?.power ?? "on"} onChange={(e) => patch(r.key, { power: e.target.value as "on" | "off" })}>
                <option value="on">Power ON</option>
                <option value="off">Power OFF</option>
              </select>
            )}
          </div>
        );
      })}

      {epsIds.length > 0 && (
        <label className="field">
          <span>Apply automatically when power turns on</span>
          <select value={powerOn} onChange={(e) => setPowerOn(e.target.value)}>
            <option value="">Never (manual only)</option>
            <option value="all">Any power unit</option>
            {epsIds.map((id) => {
              const d = state.devices.find((x) => x.id === id)!;
              return <option key={id} value={id}>{d.label}</option>;
            })}
          </select>
        </label>
      )}

      <div className="modal-actions">
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save"}</button>
      </div>
    </Modal>
  );
}
