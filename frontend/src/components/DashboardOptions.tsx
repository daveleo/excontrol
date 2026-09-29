import type { DeviceState, SetupDevice } from "@excontrol/shared";
import { presetKey } from "@excontrol/shared";

/**
 * Setup › device: what the dashboards show of this device.
 *  - "Show on dashboard" per preset — service/test looks (mapping, test patterns) stay
 *    usable in scenes and here, but customers and operators don't see them.
 *  - Input names (H-series) — "input 4-1" → "Laptop", used in the preset pictures.
 * Built from what the device reported (live state), so it lists real presets and inputs.
 */
export function DashboardOptions({
  d, live, onChange,
}: {
  d: SetupDevice;
  live?: DeviceState;
  onChange: (patch: Partial<SetupDevice>) => void;
}) {
  const zones = (live?.zones ?? []).filter((z) => z.presets?.length);
  if (!zones.length) return null;
  const hidden = new Set(d.hiddenPresets ?? []);
  const toggle = (key: string, show: boolean) => {
    const next = new Set(hidden);
    if (show) next.delete(key);
    else next.add(key);
    onChange({ hiddenPresets: [...next] });
  };
  const sources = [...new Set(zones.flatMap((z) => z.presets!.flatMap((p) => p.layers?.map((l) => l.source) ?? [])))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  const names = d.inputNames ?? {};
  const noun = d.type === "obs" ? "scenes" : d.type === "exview" ? "inputs" : "presets";

  return (
    <div className="wd-dash">
      <div className="wd-dash-title">On the dashboard</div>
      <p className="muted small">Untick {noun} customers shouldn't see (test patterns, mapping). They stay usable in scenes.</p>
      {zones.map((z) => (
        <div key={z.id} className="wd-dash-zone">
          {zones.length > 1 && <div className="dc-label">{z.label}</div>}
          <div className="wd-dash-list">
            {z.presets!.map((p) => {
              const key = presetKey(z.id, p.id);
              return (
                <label key={key} className="wd-check">
                  <input type="checkbox" checked={!hidden.has(key)} onChange={(e) => toggle(key, e.target.checked)} />
                  {p.name}
                </label>
              );
            })}
          </div>
        </div>
      ))}
      {sources.length > 0 && (
        <>
          <div className="wd-dash-title">Input names</div>
          <p className="muted small">What customers call each input — shown in the preset pictures.</p>
          <div className="wd-inputs">
            {sources.map((s) => (
              <label key={s} className="field narrow">
                <span>{s}</span>
                <input
                  value={names[s] ?? ""}
                  placeholder={s.replace(/^input\s+/i, "")}
                  maxLength={40}
                  onChange={(e) => onChange({ inputNames: { ...names, [s]: e.target.value } })}
                />
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
