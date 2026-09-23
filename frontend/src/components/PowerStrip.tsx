import { useState } from "react";
import type { AppState, DeviceState } from "@excontrol/shared";
import { runAction, setOn, verifyToken } from "../api.js";
import { ensureUnlocked } from "../lib/unlock.js";
import { epsStatus, outputOwner } from "../lib/status.js";

/** Power units, slim, at the bottom: name, six output dots (hover for what's on each), one
 *  word. Relay-level control is behind "Details" — an installer's tool, not an operator's. */
export function PowerStrip({ state }: { state: AppState }) {
  const units = state.devices.filter((d) => d.type === "expromo-eps");
  if (!units.length) return null;
  return (
    <section className="power-strip" aria-label="Power units">
      <div className="ps-title">Power</div>
      {units.map((u) => <Unit key={u.id} eps={u} state={state} />)}
    </section>
  );
}

function Unit({ eps, state }: { eps: DeviceState; state: AppState }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const domain = state.powerDomains.find((p) => p.id === eps.id);
  const s = epsStatus(eps, domain);
  const bits = String(eps.extra?.outputs ?? "");
  const d5 = String(eps.extra?.d5 ?? "") === "ON";

  const toggleOpen = async () => {
    if (!open && !(await ensureUnlocked(state.app.settingsLocked, verifyToken))) return;
    setOpen((v) => !v);
  };
  const act = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    setErr(null);
    try { await fn(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  return (
    <div className={`ps-unit ${open ? "open" : ""}`}>
      <div className="ps-row">
        <span className="ps-name">{eps.label}</span>
        <span className="ps-outs" aria-label={`outputs ${bits || "unknown"}`}>
          {[1, 2, 3, 4, 5, 6].map((i) => {
            const on = bits[i - 1] === "1";
            const owner = outputOwner(eps, state.devices, i);
            return <i key={i} className={on ? "on" : ""} title={`Output ${i}: ${on ? "on" : "off"}${owner ? ` — ${owner}` : ""}`} />;
          })}
        </span>
        <span className={`ps-word tone-${s.tone}`}><span className={`sdot ${s.tone}`} aria-hidden />{s.word}</span>
        <button className="linkish ps-details" onClick={() => void toggleOpen()} aria-expanded={open}>
          {open ? "Close" : "Details"}
        </button>
      </div>
      {s.tone === "fault" && <div className="ps-hint fault">{s.hint}</div>}
      {open && (
        <div className="ps-detail">
          <div className="ps-actions">
            <button disabled={busy} onClick={act(() => runAction(eps.id, "power_on"))}>Power on</button>
            <button disabled={busy} onClick={act(() => runAction(eps.id, "power_off"))}>Power off</button>
            <span className="muted small">Whole unit. Switching on a partly-on unit adds only the missing outputs.</span>
          </div>
          <ul className="ps-outlist">
            {[1, 2, 3, 4, 5, 6].map((i) => {
              const zone = eps.zones.find((z) => z.relay === i);
              const on = bits[i - 1] === "1";
              const owner = outputOwner(eps, state.devices, i);
              return (
                <li key={i}>
                  <span className={`sdot ${on ? "on" : "off"}`} aria-hidden />
                  <span className="ps-o">Output {i}</span>
                  <span className="ps-owner">{zone?.label && zone.label !== `Output ${i}` ? zone.label : owner || <span className="muted">—</span>}</span>
                  {zone ? (
                    <button disabled={busy} onClick={act(() => setOn(eps.id, zone.id, !on))}>{on ? "Switch off" : "Switch on"}</button>
                  ) : <span className="muted small">{on ? "on" : "off"}</span>}
                </li>
              );
            })}
          </ul>
          {!eps.zones.length && (
            <p className="muted small">Single outputs can be switched here once "independent output control" is on in Setup › Devices.</p>
          )}
          {d5 && <p className="muted small">Its wall-switch input (D5) is on — flicking that switch changes power too.</p>}
          {err && <p className="err small">{err}</p>}
        </div>
      )}
    </div>
  );
}

