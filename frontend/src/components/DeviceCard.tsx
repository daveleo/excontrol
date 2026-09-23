import { useRef, useState } from "react";
import type { DeviceState, ZoneState, PowerLevel, DeviceTarget } from "@excontrol/shared";
import { setBrightness, setVolume, recallPreset, setBlackout, setOn, runAction, setPowerState } from "../api.js";

const TARGET_LABEL = { on: "On", standby: "Standby", off: "Off" } as const;

const STATUS_LABEL: Record<DeviceState["status"], string> = {
  connecting: "Connecting…",
  online: "Online",
  initializing: "Starting up…",
  "powered-off": "Powered down",
  offline: "Offline",
  error: "Error",
};

/** Blackout is a NovaStar-only concept — an eXview's "off" is its own on/off toggle below. */
const hasZoneControls = (t: DeviceState["type"]) => t === "novastar-h" || t === "novastar-coex";
const hasBrightness = (t: DeviceState["type"]) => hasZoneControls(t) || t === "exview";

export function DeviceCard({
  device, powerLevel, target, allDevices = [],
}: {
  device: DeviceState;
  powerLevel?: PowerLevel;
  /** the power engine's resolved target for this device, if any group has set one */
  target?: DeviceTarget;
  /** for naming what hangs off an EPS's outputs */
  allDevices?: DeviceState[];
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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

  const controllable = device.status === "online";
  const isEps = device.type === "expromo-eps";
  const isObs = device.type === "obs";
  const multiZone = device.zones.length > 1;
  const showingLastKnown =
    !controllable &&
    (device.zones.some((z) => (z.presets?.length ?? 0) > 0 || z.brightness != null || z.volume != null || z.blackout != null || z.on != null) ||
      (isEps && !!device.extra && Object.keys(device.extra).length > 0));

  return (
    <section className="card" data-status={device.status}>
      <div className="card-head">
        <h2>{device.label}</h2>
        <span className={`status ${device.status}`}>{STATUS_LABEL[device.status]}</span>
      </div>

      {target?.target && (
        <p className={`target-line t-${target.target}`}>
          <b>{TARGET_LABEL[target.target]}</b>
          {target.manual ? " · set on this card" : ` · via ${target.via.join(", ")}`}
          {target.effect && <span className="muted"> — {target.effect}</span>}
        </p>
      )}
      {device.poweredBy && (
        <p className="hint muted small">
          Power: {allDevices.find((d) => d.id === device.poweredBy)?.label ?? device.poweredBy}
          {device.poweredByOutput ? `, output ${device.poweredByOutput}` : ", whole unit"}
        </p>
      )}
      {device.status === "powered-off" && (
        <p className="hint muted">Waiting for power. Controls return once this equipment is on.</p>
      )}
      {device.status === "initializing" && (
        <p className="hint muted">
          {device.type === "exview" && device.error
            ? `${device.error[0]!.toUpperCase()}${device.error.slice(1)}…`
            : "Booting — this can take up to a minute."}
        </p>
      )}
      {device.status === "offline" && !isEps && <p className="err">Not responding. {device.error}</p>}
      {showingLastKnown && (
        <p className="cache-hint">Showing last known configuration — not live while {device.label} is unreachable.</p>
      )}

      {isEps && <EpsBody device={device} powerLevel={powerLevel} guard={guard} busy={busy} allDevices={allDevices} />}

      {!isEps &&
        device.zones.map((z) => (
          <ZoneControls
            key={z.id}
            zone={z}
            deviceType={device.type}
            showLabel={multiZone}
            disabled={busy || !controllable}
            onBrightness={(v) => guard(() => setBrightness(device.id, z.id, v))()}
            onVolume={(v) => guard(() => setVolume(device.id, z.id, v))()}
            onPreset={(id) => guard(() => recallPreset(device.id, z.id, id))()}
            onBlackout={(on) => guard(() => setBlackout(device.id, z.id, on))()}
            onOn={(on) => guard(() => setOn(device.id, z.id, on))()}
            onPowerState={(st) => guard(() => setPowerState(device.id, z.id, st))()}
          />
        ))}

      {isObs && device.extra?.programScene != null && (
        <p className="hint">scene: {String(device.extra.programScene)}</p>
      )}

      {!isEps && hasBrightness(device.type) && device.zones.every((z) => !z.presets?.length) && controllable && (
        <p className="hint muted">No presets configured on this device yet.</p>
      )}

      {err && <p className="err">{err}</p>}
    </section>
  );
}

function ZoneControls({
  zone,
  deviceType,
  showLabel,
  disabled,
  onBrightness,
  onVolume,
  onPreset,
  onBlackout,
  onOn,
  onPowerState,
}: {
  zone: ZoneState;
  deviceType: DeviceState["type"];
  showLabel: boolean;
  disabled: boolean;
  onBrightness: (v: number) => void;
  onVolume: (v: number) => void;
  onPreset: (id: number) => void;
  onBlackout: (on: boolean) => void;
  onOn: (on: boolean) => void;
  onPowerState: (state: "on" | "blackout" | "standby") => void;
}) {
  const controls = hasZoneControls(deviceType);
  return (
    <div className="zone">
      {showLabel && <div className="zone-label">{zone.label}</div>}

      {deviceType === "exview" && (
        <div className="seg power-seg" role="group" aria-label="Screen power">
          {(["on", "blackout", "standby"] as const).map((st) => (
            <button
              key={st}
              className={`${zone.powerState === st ? "active " : ""}t-${st === "on" ? "on" : st === "blackout" ? "standby" : "off"}`}
              disabled={disabled}
              onClick={() => onPowerState(st)}
              title={st === "blackout" ? "Picture off, instantly reversible" : st === "standby" ? "Deep standby (0xC007) — takes ~20 s, wake takes 30–70 s" : "Picture on"}
            >
              {st === "on" ? "On" : st === "blackout" ? "Blackout" : "Standby"}
            </button>
          ))}
        </div>
      )}

      {deviceType !== "exview" && zone.on != null && (
        <button
          className={`blackout-btn power-btn ${zone.powerState === "standby" ? "standby" : zone.on ? "on" : ""}`}
          disabled={disabled}
          onClick={() => onOn(!zone.on)}
        >
          <span className="bo-dot" />
          {zone.powerState === "standby"
            ? "Standby — tap to wake"
            : zone.powerState === "blackout"
              ? "Blackout — tap to turn on"
              : zone.on
                ? "On — tap to turn off"
                : "Off — tap to turn on"}
        </button>
      )}

      {zone.powerState === "blackout" && (
        <p className="hint muted">Screen will go into standby mode after the pre-configured time.</p>
      )}

      {hasBrightness(deviceType) && (
        <Brightness value={zone.brightness ?? 0} disabled={disabled} onCommit={onBrightness} />
      )}

      {zone.volume != null && (
        <Volume value={zone.volume} disabled={disabled} onCommit={onVolume} />
      )}

      {controls && (
        <button
          className={`blackout-btn ${zone.blackout ? "on" : ""}`}
          disabled={disabled}
          onClick={() => onBlackout(!zone.blackout)}
        >
          <span className="bo-dot" />
          {zone.blackout ? "Blackout ON — tap to show" : "Blackout OFF — tap to black out"}
        </button>
      )}

      {(zone.presets?.length ?? 0) > 0 && (
        <div className="presets-section">
          <div className="section-label">{deviceType === "obs" ? "Scenes" : deviceType === "exview" ? "Source" : "Presets"}</div>
          <div className="presets">
            {zone.presets!.map((p) => (
              <button
                key={p.id}
                className={zone.activePreset === p.id ? "preset active" : "preset"}
                disabled={disabled}
                onClick={() => onPreset(p.id)}
                title={p.hasSignal == null ? undefined : p.hasSignal ? "Signal present" : "No signal"}
              >
                {p.hasSignal != null && <span className={`sig-dot ${p.hasSignal ? "live" : ""}`} />}
                {p.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function EpsBody({
  device,
  powerLevel,
  guard,
  busy,
  allDevices,
}: {
  device: DeviceState;
  allDevices: DeviceState[];
  powerLevel?: PowerLevel;
  guard: (fn: () => Promise<unknown>) => () => Promise<void>;
  busy: boolean;
}) {
  const e = device.extra ?? {};
  const outputs = typeof e.outputs === "string" ? e.outputs : "";
  const state = String(e.state ?? "");
  const system = String(e.system ?? "");
  const offOutputs = [...outputs].map((c, i) => (c === "0" ? i + 1 : 0)).filter(Boolean);
  const members = allDevices.filter((d) => d.poweredBy === device.id);
  const claimed = new Map(members.filter((d) => d.poweredByOutput).map((d) => [d.poweredByOutput!, d.label]));
  const whole = members.filter((d) => !d.poweredByOutput).map((d) => d.label);
  const ownerOf = (i: number) => claimed.get(i) ?? (whole.length ? whole.join(", ") : "");
  const d5 = String(e.d5 ?? "");

  const big =
    powerLevel === "starting" ? "INITIALIZING…"
    : system === "OFF" ? "SYSTEM OFF"
    : state === "SEQUENCING" ? "STARTING…"
    : state === "FULLY_ON" ? "SYSTEM ON"
    : system || "—";

  return (
    <div className="eps-body">
      <div className={`eps-status ${powerLevel ?? "unknown"}`}>{big}</div>

      {outputs && (
        <div className="eps-outputs">
          <span className="section-label">Outputs</span>
          <div className="out-dots">
            {[...outputs].map((c, i) => (
              <span key={i} className={c === "1" ? "out on" : "out off"} title={`Output ${i + 1}${ownerOf(i + 1) ? " — " + ownerOf(i + 1) : ""}`} />
            ))}
          </div>
        </div>
      )}
      {offOutputs.length > 0 && system === "ON" && (
        <p className="hint">
          Partly on — output {offOutputs.join(", ")} off
          {offOutputs.some((i) => ownerOf(i)) && ` (${[...new Set(offOutputs.map(ownerOf).filter(Boolean))].join("; ")})`}.
          {" "}Power on switches on only the missing outputs; the running ones stay on.
        </p>
      )}
      {claimed.size > 0 && (
        <p className="hint muted small">
          {[...claimed].sort((a, b) => a[0] - b[0]).map(([i, l]) => `out ${i}: ${l}`).join(" · ")}
          {whole.length > 0 && ` · rest: ${whole.join(", ")}`}
        </p>
      )}
      {d5 === "ON" && <p className="hint">Wall switch input (D5) is ON — flicking it changes power too.</p>}
      {String(e.net ?? "") && String(e.net) !== "OK" && <p className="err">Network: {String(e.net)}</p>}

      <div className="actions">
        <button disabled={busy} onClick={guard(() => runAction(device.id, "power_on"))}>Power on</button>
        <button disabled={busy} onClick={guard(() => runAction(device.id, "power_off"))}>Power off</button>
      </div>
      {e.label != null && <p className="hint muted">{String(e.label)}</p>}

      {device.zones.length > 0 && (
        <div className="eps-named-outputs">
          <span className="section-label">Outputs</span>
          {device.zones.map((z) => (
            <button
              key={z.id}
              className={`output-row ${z.on ? "on" : ""}`}
              disabled={busy}
              onClick={guard(() => setOn(device.id, z.id, !z.on))}
            >
              <span className="output-dot" />
              <span className="output-label">{z.label}</span>
              <span className="output-state">{z.on == null ? "—" : z.on ? "ON" : "OFF"}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Brightness({ value, disabled, onCommit }: { value: number; disabled: boolean; onCommit: (v: number) => void }) {
  return <PercentSlider label="Brightness" value={value} disabled={disabled} onCommit={onCommit} className="brightness" />;
}

function Volume({ value, disabled, onCommit }: { value: number; disabled: boolean; onCommit: (v: number) => void }) {
  return <PercentSlider label="Volume" value={value} disabled={disabled} onCommit={onCommit} className="brightness" />;
}

function PercentSlider({
  label,
  value,
  disabled,
  onCommit,
  className,
}: {
  label: string;
  value: number;
  disabled: boolean;
  onCommit: (v: number) => void;
  className: string;
}) {
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
    <label className={className}>
      <span>{label}</span>
      <input
        type="range"
        min={0}
        max={100}
        value={shown}
        disabled={disabled}
        onChange={(e) => setLocal(Number(e.target.value))}
        onMouseUp={commit}
        onTouchEnd={commit}
        onKeyUp={commitDebounced}
      />
      <span className="pct">{shown}%</span>
    </label>
  );
}
