import { useEffect, useState } from "react";
import type { AppState, DeviceState, GroupState, PowerTarget } from "@excontrol/shared";
import { ALL_GROUP } from "@excontrol/shared";
import { setGroupState } from "../api.js";

const TARGET_LABEL: Record<PowerTarget, string> = { on: "On", standby: "Standby", off: "Off" };

/** What the device is actually doing right now — mirrors the engine's own `observe()`. */
export function observedState(d: DeviceState): { text: string; cls: string } {
  if (d.status === "powered-off") return { text: "no power", cls: "off" };
  if (d.status === "initializing" || d.status === "connecting") return { text: "starting", cls: "starting" };
  if (d.status !== "online") return { text: "offline", cls: "fault" };
  if (d.type === "exview") {
    const ps = d.zones[0]?.powerState;
    if (ps === "standby") return { text: "standby", cls: "standby" };
    if (ps === "blackout") return { text: "blackout", cls: "standby" };
    return { text: "on", cls: "on" };
  }
  if ((d.type === "novastar-h" || d.type === "novastar-coex") && d.zones.length && d.zones.every((z) => z.blackout)) {
    return { text: "blacked out", cls: "standby" };
  }
  return { text: "on", cls: "on" };
}

/** One card per power group ("Everything" first): set On / Standby / Off, and see — per
 *  member — what it's doing and which group decided that. */
export function PowerGroups({ state }: { state: AppState }) {
  const groups = state.groups ?? [];
  if (!groups.length) return null;
  return (
    <section className="groups-row" aria-label="Power groups">
      {groups.map((g) => <GroupCard key={g.id} group={g} state={state} />)}
    </section>
  );
}

function GroupCard({ group, state }: { group: GroupState; state: AppState }) {
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState<PowerTarget | null>(null);
  const [open, setOpen] = useState(group.id !== ALL_GROUP);
  const isAll = group.id === ALL_GROUP;

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(null), 3500);
    return () => clearTimeout(t);
  }, [armed]);

  const go = async (t: PowerTarget) => {
    // Everything → Off / Standby asks for a second tap: it's the one button that can dark the whole venue.
    if (isAll && t !== "on" && armed !== t) {
      setArmed(t);
      return;
    }
    setArmed(null);
    setBusy(true);
    try { await setGroupState(group.id, t); } catch { /* toast from server */ } finally { setBusy(false); }
  };

  const members = group.members
    .map((id) => state.devices.find((d) => d.id === id))
    .filter((d): d is DeviceState => !!d);
  const when = group.setAt ? new Date(group.setAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

  return (
    <div className={`card group-card ${isAll ? "all" : ""}`} data-busy={group.busy || undefined}>
      <div className="card-head">
        <h2>{group.label}</h2>
        {group.target
          ? <span className={`gtarget ${group.target}`}>{TARGET_LABEL[group.target]}</span>
          : <span className="gtarget none">not set</span>}
      </div>
      <div className="gsummary">{group.summary}</div>
      {group.target && group.setBy && <div className="gsetby">set by {group.setBy} · {when}</div>}
      {group.busy && (
        <div className="gprogress"><span className="pb-spinner small" aria-hidden />{group.progress ?? "Working…"}</div>
      )}

      <div className="seg" role="group" aria-label={`${group.label} power`}>
        {(["on", "standby", "off"] as PowerTarget[]).map((t) => (
          <button
            key={t}
            className={`${group.target === t ? "active " : ""}${armed === t ? "armed" : ""} t-${t}`}
            disabled={busy}
            onClick={() => void go(t)}
          >
            {armed === t ? `Tap again: all ${TARGET_LABEL[t]}` : TARGET_LABEL[t]}
          </button>
        ))}
      </div>

      <button className="linkish gtoggle" onClick={() => setOpen((v) => !v)}>
        {open ? "▾" : "▸"} {members.length} device{members.length === 1 ? "" : "s"}
      </button>
      {open && (
        <ul className="gmembers">
          {members.map((d) => {
            const obs = observedState(d);
            const t = state.deviceTargets?.find((x) => x.deviceId === d.id);
            const otherGroup = t?.target && group.target && t.target !== group.target && !t.manual;
            return (
              <li key={d.id}>
                <div className="gm-line">
                  <span className="gm-name">{d.label}</span>
                  <span className={`gm-state ${obs.cls}`}>{obs.text}</span>
                </div>
                {t?.target && (
                  <div className={`gm-why ${otherGroup ? "override" : ""}`}>
                    → {TARGET_LABEL[t.target]}
                    {t.manual ? " (manual, on its own card)" : ` via ${t.via.join(", ")}`}
                    {otherGroup && " — the highest target among its groups wins"}
                    {t.effect && <span className="gm-effect"> · {t.effect}</span>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
