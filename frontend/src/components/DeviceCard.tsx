import { useRef, useState } from "react";
import type { DeviceState, ZoneState, DeviceTarget } from "@excontrol/shared";
import { setBrightness, setVolume, recallPreset, setBlackout, setPowerState } from "../api.js";
import { deviceStatus, lastKnown } from "../lib/status.js";

/**
 * One anatomy for every device: name + one status word on top, then the picture control,
 * then sliders, then inputs/presets — always in that order. A device that has no power or
 * isn't responding collapses to one line instead of showing dimmed controls that do
 * nothing. On a phone (`narrow`) cards start collapsed to their header + picture control.
 */
export function DeviceCard({
  device, target, narrow = false,
}: {
  device: DeviceState;
  target?: DeviceTarget;
  narrow?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(!narrow);
  const s = deviceStatus(device);
  const online = device.status === "online";
  const expanded = !narrow || open;

  const guard = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // "Why" only when it's surprising — a normal group-driven state is what the power bar says.
  const chips: string[] = [];
  if (target?.manual) chips.push("Set by hand");
  if (target?.heldBy?.length) chips.push(`Kept on — shares power with ${target.heldBy.join(", ")}`);

  const hint = !online
    ? s.tone === "fault" ? s.hint : s.hint ?? lastKnown(device)
    : undefined;

  return (
    <section className={`dcard tone-${s.tone} ${online ? "" : "slim"}`} data-type={device.type}>
      {narrow && online ? (
        <button className="dc-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <h2>{device.label}</h2>
          <span className="dc-status"><span className={`sdot ${s.tone}`} aria-hidden />{s.word}</span>
          <span className="dc-chev" aria-hidden>{open ? "▾" : "▸"}</span>
        </button>
      ) : (
        <div className="dc-head">
          <h2>{device.label}</h2>
          <span className="dc-status"><span className={`sdot ${s.tone}`} aria-hidden />{s.word}</span>
        </div>
      )}

      {chips.map((c) => <span key={c} className="dc-chip">{c}</span>)}

      {!online && hint && (
        <p className={`dc-hint ${s.tone === "fault" ? "fault" : ""}`} title={s.detail}>{hint}</p>
      )}

      {online && device.type === "obs" && (
        <Options
          zone={device.zones[0]}
          disabled={busy}
          onPick={(id) => guard(() => recallPreset(device.id, device.zones[0]?.id, id))()}
        />
      )}

      {online && device.type !== "obs" && device.zones.map((z) => (
        <div className="dc-zone" key={z.id}>
          {device.zones.length > 1 && <div className="dc-zone-label">{z.label}</div>}
          <Picture
            zone={z}
            type={device.type}
            disabled={busy}
            onPower={(st) => guard(() => setPowerState(device.id, z.id, st))()}
            onBlack={(b) => guard(() => setBlackout(device.id, z.id, b))()}
          />
          {expanded && (
            <>
              {typeof z.brightness === "number" && (
                <PercentSlider label="Brightness" value={z.brightness} disabled={busy} onCommit={(v) => guard(() => setBrightness(device.id, z.id, v))()} />
              )}
              {typeof z.volume === "number" && (
                <PercentSlider label="Volume" value={z.volume} disabled={busy} onCommit={(v) => guard(() => setVolume(device.id, z.id, v))()} />
              )}
              <Options
                zone={z}
                label={device.type === "exview" ? "Input" : "Presets"}
                disabled={busy}
                onPick={(id) => guard(() => recallPreset(device.id, z.id, id))()}
              />
            </>
          )}
        </div>
      ))}

      {err && <p className="dc-hint fault">{err}</p>}
    </section>
  );
}

/** The same segmented control for every display: On · Black (· Standby on eXview). */
function Picture({
  zone, type, disabled, onPower, onBlack,
}: {
  zone: ZoneState;
  type: DeviceState["type"];
  disabled: boolean;
  onPower: (st: "on" | "blackout" | "standby") => void;
  onBlack: (black: boolean) => void;
}) {
  if (type === "exview") {
    const ps = zone.powerState ?? (zone.on ? "on" : undefined);
    const items: { st: "on" | "blackout" | "standby"; label: string; title: string; tone: string }[] = [
      { st: "on", label: "On", title: "Picture on", tone: "on" },
      { st: "blackout", label: "Black", title: "Picture off at once — turns back on instantly", tone: "warn" },
      { st: "standby", label: "Standby", title: "Deep standby — ~20 s to enter, 30–70 s to wake", tone: "warn" },
    ];
    return (
      <>
        <div className="seg seg-full" role="group" aria-label="Picture">
          {items.map((it) => (
            <button key={it.st} title={it.title} className={`t-${it.tone} ${ps === it.st ? "active" : ""}`} disabled={disabled} onClick={() => onPower(it.st)}>
              {it.label}
            </button>
          ))}
        </div>
        {ps === "blackout" && <p className="dc-hint">Goes to standby on its own after a while.</p>}
      </>
    );
  }
  if (zone.blackout == null) return null;
  return (
    <div className="seg seg-full" role="group" aria-label="Picture">
      <button className={`t-on ${!zone.blackout ? "active" : ""}`} disabled={disabled} onClick={() => onBlack(false)}>On</button>
      <button className={`t-warn ${zone.blackout ? "active" : ""}`} disabled={disabled} onClick={() => onBlack(true)}>Black</button>
    </div>
  );
}

function Options({
  zone, label, disabled, onPick,
}: {
  zone?: ZoneState;
  label?: string;
  disabled: boolean;
  onPick: (id: number) => void;
}) {
  if (!zone?.presets?.length) return null;
  return (
    <div className="dc-opts">
      {label && <div className="dc-label">{label}</div>}
      <div className="dc-opt-row">
        {zone.presets.map((p) => (
          <button
            key={p.id}
            className={zone.activePreset === p.id ? "opt active" : "opt"}
            disabled={disabled}
            onClick={() => onPick(p.id)}
            title={p.hasSignal == null ? undefined : p.hasSignal ? "Signal present" : "No signal"}
          >
            {p.hasSignal != null && <span className={`sig ${p.hasSignal ? "live" : ""}`} aria-hidden />}
            {p.name}
          </button>
        ))}
      </div>
    </div>
  );
}

function PercentSlider({ label, value, disabled, onCommit }: { label: string; value: number; disabled: boolean; onCommit: (v: number) => void }) {
  const [local, setLocal] = useState<number | null>(null);
  const shown = local ?? value;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const commit = () => {
    if (timer.current) clearTimeout(timer.current);
    if (local != null) onCommit(local);
    setLocal(null);
  };
  // keyboard: arrow keys fire rapid changes — commit once they settle
  const commitDebounced = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(commit, 400);
  };
  return (
    <label className="dc-slider">
      <span>{label}</span>
      <input
        type="range" min={0} max={100} value={shown} disabled={disabled}
        onChange={(e) => setLocal(Number(e.target.value))}
        onMouseUp={commit} onTouchEnd={commit} onKeyUp={commitDebounced}
      />
      <span className="pct">{shown}%</span>
    </label>
  );
}
