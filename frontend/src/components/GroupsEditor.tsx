import { useState } from "react";
import type { AppState, GroupConfig, DeviceState } from "@excontrol/shared";
import { saveGroups, verifyToken } from "../api.js";
import { ensureUnlocked } from "../lib/unlock.js";

/** Devices the power engine can act on — mirrors the backend's isControllable(). */
function controllable(d: DeviceState): boolean {
  return d.type === "exview" || d.type === "novastar-h" || d.type === "novastar-coex" || (!!d.poweredBy && d.type !== "expromo-eps");
}

function slug(label: string, taken: Set<string>): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "group";
  let id = base === "all" ? "all-group" : base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

function powerNote(d: DeviceState, state: AppState): string {
  if (!d.poweredBy) return d.type === "exview" ? "own socket · standby over the network" : d.type.startsWith("novastar") ? "own socket · blackout" : "";
  const eps = state.devices.find((x) => x.id === d.poweredBy)?.label ?? d.poweredBy;
  return `${eps}${d.poweredByOutput ? ` · output ${d.poweredByOutput}` : " · whole unit"}`;
}

/** Setup › Groups. */
export function GroupsEditor({ state }: { state: AppState }) {
  const initial: GroupConfig[] = (state.groups ?? [])
    .filter((g) => g.id !== "all")
    .map((g) => ({ id: g.id, label: g.label, members: [...g.members] }));
  const [groups, setGroups] = useState<GroupConfig[]>(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const devices = state.devices.filter(controllable);

  const patch = (i: number, p: Partial<GroupConfig>) => setGroups((gs) => gs.map((g, x) => (x === i ? { ...g, ...p } : g)));
  const toggle = (i: number, id: string) =>
    setGroups((gs) => gs.map((g, x) => (x !== i ? g : { ...g, members: g.members.includes(id) ? g.members.filter((m) => m !== id) : [...g.members, id] })));

  const add = () =>
    setGroups((gs) => {
      const label = `Group ${gs.length + 1}`;
      return [...gs, { id: slug(label, new Set(gs.map((g) => g.id))), label, members: [] }];
    });

  const save = async () => {
    if (!(await ensureUnlocked(state.app.settingsLocked, verifyToken))) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await saveGroups(groups);
      setGroups(res.groups);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <p className="modal-lead">
        A group is a set of screens you switch together — On, Standby or Off — shown as a row
        under the power bar. A screen can be in several groups; it then follows the <b>highest</b>
        of them (On beats Standby beats Off), so switching one group off never cuts something
        another group still wants on. The power bar itself always covers every device.
      </p>

      {groups.length === 0 && <p className="hint muted">No groups yet — the power bar still switches the whole room.</p>}

      {groups.map((g, i) => (
        <div key={g.id} className="grp-edit">
          <div className="grp-edit-head">
            <input
              className="grp-label" value={g.label} placeholder="Group name"
              onChange={(e) => patch(i, { label: e.target.value })}
            />
            <button className="icon-btn" aria-label={`Remove ${g.label}`} onClick={() => setGroups((gs) => gs.filter((_, x) => x !== i))}>✕</button>
          </div>
          <div className="grp-members">
            {devices.map((d) => (
              <label key={d.id} className="toggle grp-member">
                <input type="checkbox" checked={g.members.includes(d.id)} onChange={() => toggle(i, d.id)} />
                <span>{d.label}</span>
                <span className="muted small">{powerNote(d, state)}</span>
              </label>
            ))}
          </div>
        </div>
      ))}

      {err && <p className="err">{err}</p>}
      <div className="modal-actions">
        <button onClick={add}>+ Add group</button>
        <button className="primary" disabled={saving} onClick={save}>
          {saved ? "Saved ✓" : saving ? "Saving…" : "Save"}
        </button>
      </div>
    </>
  );
}
