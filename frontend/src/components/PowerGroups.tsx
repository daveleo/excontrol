import { useState } from "react";
import type { AppState, DeviceState, GroupState, PowerTarget } from "@excontrol/shared";
import { ALL_GROUP } from "@excontrol/shared";
import { setGroupState } from "../api.js";
import { deviceStatus } from "../lib/status.js";

const WORD: Record<PowerTarget, string> = { on: "On", standby: "Standby", off: "Off" };

/** Configured groups as compact rows under the power bar — only when there are any. The
 *  room-wide group lives in the power bar itself. */
export function GroupRows({ state }: { state: AppState }) {
  const groups = (state.groups ?? []).filter((g) => g.id !== ALL_GROUP);
  if (!groups.length) return null;
  return (
    <section className="group-rows" aria-label="Groups">
      {groups.map((g) => <GroupRow key={g.id} group={g} state={state} />)}
    </section>
  );
}

function GroupRow({ group, state }: { group: GroupState; state: AppState }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const members = group.members
    .map((id) => state.devices.find((d) => d.id === id))
    .filter((d): d is DeviceState => !!d);

  const go = async (t: PowerTarget) => {
    setBusy(true);
    try { await setGroupState(group.id, t); } catch { /* toast */ } finally { setBusy(false); }
  };

  return (
    <div className="grow" data-busy={group.busy || undefined}>
      <button className="grow-name" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="grow-label">{group.label}</span>
        <span className="grow-sum">
          {group.busy
            ? <><span className="pb-spinner small" aria-hidden />{group.progress ?? "Working…"}</>
            : summary(members)}
        </span>
      </button>
      <div className="seg seg-sm" role="group" aria-label={`${group.label} power`}>
        {(["on", "standby", "off"] as PowerTarget[]).map((t) => (
          <button key={t} className={`t-${t} ${group.target === t ? "active" : ""}`} disabled={busy} onClick={() => void go(t)}>
            {WORD[t]}
          </button>
        ))}
      </div>
      {open && (
        <ul className="grow-members">
          {members.map((d) => {
            const s = deviceStatus(d);
            const t = state.deviceTargets?.find((x) => x.deviceId === d.id);
            return (
              <li key={d.id}>
                <span className={`sdot ${s.tone}`} aria-hidden />
                <span className="gm-name">{d.label}</span>
                <span className="gm-word">{s.word}</span>
                {t?.target && t.target !== group.target && (
                  <span className="gm-note">
                    {t.manual ? "set by hand" : `${WORD[t.target]} — ${t.via.join(", ")} wants it ${WORD[t.target].toLowerCase()}`}
                  </span>
                )}
                {t?.heldBy?.length ? <span className="gm-note">kept powered for {t.heldBy.join(", ")}</span> : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** "2 on", "1 standby · 1 no power" — short, in the same words the cards use. */
function summary(members: DeviceState[]): string {
  const counts = new Map<string, number>();
  for (const d of members) {
    const w = deviceStatus(d).word.toLowerCase();
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  if (counts.size === 1) {
    const [w, n] = [...counts][0]!;
    return n === members.length && n > 1 ? `all ${w}` : `${n} ${w}`;
  }
  return [...counts].map(([w, n]) => `${n} ${w}`).join(" · ");
}
