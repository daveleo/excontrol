import { useRef, useState } from "react";
import type { DeviceState, ZoneState, PowerLevel } from "@excontrol/shared";
import { setBrightness, recallPreset, setBlackout, setOn, runAction } from "../api.js";

const STATUS_LABEL: Record<DeviceState["status"], string> = {
  connecting: "Connecting…",
  online: "Online",
  initializing: "Starting up…",
  "powered-off": "Powered down",
  offline: "Offline",
  error: "Error",
};

const hasZoneControls = (t: DeviceState["type"]) => t === "novastar-h" || t === "novastar-coex";

export function DeviceCard({ device, powerLevel }: { device: DeviceState; powerLevel?: PowerLevel }) {
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

  return (
    <section className="card" data-status={device.status}>
      <div className="card-head">
        <h2>{device.label}</h2>
        <span className={`status ${device.status}`}>{STATUS_LABEL[device.status]}</span>
      </div>

      {device.status === "powered-off" && (
        <p className="hint muted">Waiting for power. Controls return once this equipment is on.</p>
      )}
      {device.status === "initializing" && (
        <p className="hint muted">Booting — this can take up to a minute.</p>
      )}
      {device.status === "offline" && !isEps && <p className="err">Not responding. {device.error}</p>}

      {isEps && <EpsBody device={device} powerLevel={powerLevel} guard={guard} busy={busy} />}

      {!isEps &&
        device.zones.map((z) => (
          <ZoneControls
            key={z.id}
            zone={z}
            deviceType={device.type}
            showLabel={multiZone}
            disabled={busy || !controllable}
            onBrightness={(v) => guard(() => setBrightness(device.id, z.id, v))()}
            onPreset={(id) => guard(() => recallPreset(device.id, z.id, id))()}
            onBlackout={(on) => guard(() => setBlackout(device.id, z.id, on))()}
          />
        ))}

      {isObs && device.extra?.programScene != null && (
        <p className="hint">scene: {String(device.extra.programScene)}</p>
      )}

      {!isEps && hasZoneControls(device.type) && device.zones.every((z) => !z.presets?.length) && controllable && (
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
  onPreset,
  onBlackout,
}: {
  zone: ZoneState;
  deviceType: DeviceState["type"];
  showLabel: boolean;
  disabled: boolean;
  onBrightness: (v: number) => void;
  onPreset: (id: number) => void;
  onBlackout: (on: boolean) => void;
}) {
  const controls = hasZoneControls(deviceType);
  return (
    <div className="zone">
      {showLabel && <div className="zone-label">{zone.label}</div>}

      {controls && (
        <Brightness value={zone.brightness ?? 0} disabled={disabled} onCommit={onBrightness} />
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
          <div className="section-label">{deviceType === "obs" ? "Scenes" : "Presets"}</div>
          <div className="presets">
            {zone.presets!.map((p) => (
              <button
                key={p.id}
                className={zone.activePreset === p.id ? "preset active" : "preset"}
                disabled={disabled}
                onClick={() => onPreset(p.id)}
              >
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
}: {
  device: DeviceState;
  powerLevel?: PowerLevel;
  guard: (fn: () => Promise<unknown>) => () => Promise<void>;
  busy: boolean;
}) {
  const e = device.extra ?? {};
  const outputs = typeof e.outputs === "string" ? e.outputs : "";
  const state = String(e.state ?? "");
  const system = String(e.system ?? "");
  const offOutputs = [...outputs].map((c, i) => (c === "0" ? i + 1 : 0)).filter(Boolean);

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
              <span key={i} className={c === "1" ? "out on" : "out off"} title={`Output ${i + 1}`} />
            ))}
          </div>
        </div>
      )}
      {offOutputs.length > 0 && system === "ON" && <p className="err">Output {offOutputs.join(", ")} is OFF</p>}
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

function Brightness({
  value,
  disabled,
  onCommit,
}: {
  value: number;
  disabled: boolean;
  onCommit: (v: number) => void;
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
    <label className="brightness">
      <span>Brightness</span>
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
