import { useState } from "react";
import type { DeviceState, Preset, ZoneState } from "@excontrol/shared";
import { BRAND, visiblePresets, reportsActivePreset, inputName } from "@excontrol/shared";
import { useShowroom } from "../useShowroom.js";
import { PowerBar } from "./PowerBar.js";
import { SchedulerPanel } from "./SchedulerPanel.js";
import { ShutdownModal } from "./ShutdownModal.js";
import { AlertPopup } from "./AlertPopup.js";
import { PresetThumb, sourceColors } from "./PresetThumb.js";
import { recallPreset } from "../api.js";
import { RecoveryBanner } from "./RecoveryBanner.js";
import { switchView, useHold } from "../lib/viewSwitch.js";

/** The end-customer overlay (`?view=simple`): power, the schedule, and each screen's
 *  presets as pictures. No setup, no sliders, nothing to get wrong. */
export function SimpleView({ onUnauthorized }: { onUnauthorized: () => void }) {
  const { state, connected, toasts, dismiss } = useShowroom(onUnauthorized);
  const [schedule, setSchedule] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const hold = useHold(switchView);

  // Every zone with presets a customer may pick (hidden service/test presets left out) —
  // H-series screens get drawn layouts, the rest a name tile.
  const screens: Array<{ device: DeviceState; zone: ZoneState; presets: Preset[] }> = [];
  for (const d of state?.devices ?? []) {
    if (d.type === "expromo-eps") continue;
    for (const z of d.zones) {
      const presets = visiblePresets(d, z);
      if (presets.length) screens.push({ device: d, zone: z, presets });
    }
  }
  // drawn layouts first — they're the point of this view
  screens.sort((a, b) => Number(!!b.zone.canvas) - Number(!!a.zone.canvas));
  const colors = sourceColors(screens.flatMap(({ presets }) => presets.flatMap((p) => p.layers?.map((l) => l.source) ?? [])));

  const pick = async (d: DeviceState, z: ZoneState, presetId: number) => {
    const key = `${d.id}:${z.id}:${presetId}`;
    setPending(key);
    try {
      await recallPreset(d.id, z.id, presetId);
    } finally {
      setPending((p) => (p === key ? null : p));
    }
  };

  const reachable = (d: DeviceState) => d.status === "online";

  return (
    <div className="app simple">
      <header className="topbar">
        {/* press and hold: switch to the standard dashboard (presenter gesture) */}
        <div className={`brand ${hold.holding ? "holding" : ""}`} {...hold.bind}>
          {!connected && <span className="dot" data-on={false} title="reconnecting…" />}
          {BRAND.name}
        </div>
        <div className="toolbar">
          <button className="icon-text-btn" title="Schedule" disabled={!state} onClick={() => setSchedule(!schedule)}>
            <span className="btn-label">Schedule</span>
          </button>
        </div>
      </header>

      {!state && <p className="loading">Connecting…</p>}
      {state && !connected && <div className="reconnect">Reconnecting…</div>}
      <RecoveryBanner recovery={state?.app.configRecovery} customer />

      {state && (
        <>
          <PowerBar state={state} />

          {screens.map(({ device, zone, presets }) => {
            const live = reachable(device);
            const multi = device.zones.filter((z) => visiblePresets(device, z).length).length > 1;
            // OBS / eXview report what's on screen; H-series / COEX only what we last recalled.
            const confirmed = reportsActivePreset(device.type);
            return (
              <section key={`${device.id}:${zone.id}`} className="sv-screen">
                <h2 className="sv-title">
                  {multi ? zone.label : device.label}
                  {multi && <span className="sv-sub">{device.label}</span>}
                  {!live && (device.status === "powered-off"
                    ? <span className="sv-state off">off</span>
                    : <span className="sv-state">unavailable</span>)}
                </h2>
                <div className={`sv-grid${zone.canvas ? "" : " sv-grid-plain"}`}>
                  {presets.map((p) => {
                    // nothing is "live" on a screen that has no power
                    const active = live && zone.activePreset === p.id;
                    const key = `${device.id}:${zone.id}:${p.id}`;
                    return (
                      <button
                        key={p.id}
                        className={`sv-tile${active ? " active" : ""}${pending === key ? " pending" : ""}`}
                        disabled={!live}
                        onClick={() => void pick(device, zone, p.id)}
                      >
                        {zone.canvas && <PresetThumb preset={p} canvas={zone.canvas} colors={colors} nameOf={(s) => inputName(device, s)} />}
                        <span className="sv-name">
                          {p.name}
                          {active && (confirmed
                            ? <span className="sv-live">Live</span>
                            : <span className="sv-last" title="The last one chosen here — this controller doesn't report what it shows">Last chosen</span>)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}

          <ShutdownModal schedule={state.schedule} state={state} />
          {schedule && <SchedulerPanel state={state} onClose={() => setSchedule(false)} />}
          <AlertPopup alerts={state.alerts ?? []} />
        </>
      )}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.level}`} onClick={() => dismiss(t.id)}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
