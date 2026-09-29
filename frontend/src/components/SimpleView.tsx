import { useState } from "react";
import type { DeviceState, ZoneState } from "@excontrol/shared";
import { BRAND } from "@excontrol/shared";
import { useShowroom } from "../useShowroom.js";
import { PowerBar } from "./PowerBar.js";
import { SchedulerPanel } from "./SchedulerPanel.js";
import { ShutdownModal } from "./ShutdownModal.js";
import { AlertPopup } from "./AlertPopup.js";
import { ThemeToggle } from "./ThemeToggle.js";
import { PresetThumb, sourceColors } from "./PresetThumb.js";
import { recallPreset } from "../api.js";
import { RecoveryBanner } from "./RecoveryBanner.js";

/** The end-customer overlay (`?view=simple`): power, the schedule, and each screen's
 *  presets as pictures. No setup, no sliders, nothing to get wrong. */
export function SimpleView({ onUnauthorized }: { onUnauthorized: () => void }) {
  const { state, connected, toasts, dismiss } = useShowroom(onUnauthorized);
  const [schedule, setSchedule] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  // Every zone with presets to pick — H-series screens get drawn layouts, the rest a name tile.
  const screens: Array<{ device: DeviceState; zone: ZoneState }> = [];
  for (const d of state?.devices ?? []) {
    if (d.type === "expromo-eps") continue;
    for (const z of d.zones) if (z.presets?.length) screens.push({ device: d, zone: z });
  }
  // drawn layouts first — they're the point of this view
  screens.sort((a, b) => Number(!!b.zone.canvas) - Number(!!a.zone.canvas));
  const colors = sourceColors(screens.flatMap(({ zone }) => zone.presets!.flatMap((p) => p.layers?.map((l) => l.source) ?? [])));

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
  const scheduleCount = state?.schedule.entries.filter((e) => e.enabled).length ?? 0;

  return (
    <div className="app simple">
      <header className="topbar">
        <div className="brand">
          <span className="dot" data-on={connected} title={connected ? "connected" : "reconnecting…"} />
          {state?.app.name || BRAND.name}
        </div>
        <div className="toolbar">
          <button className="icon-text-btn" title="Schedule" disabled={!state} onClick={() => setSchedule(!schedule)}>
            <span className="btn-label">Schedule</span>
            {scheduleCount > 0 && <span className="badge">{scheduleCount}</span>}
          </button>
          <ThemeToggle />
        </div>
      </header>

      {!state && <p className="loading">Connecting…</p>}
      {state && !connected && <div className="reconnect">Reconnecting…</div>}
      <RecoveryBanner recovery={state?.app.configRecovery} customer />

      {state && (
        <>
          <PowerBar state={state} />

          {screens.map(({ device, zone }) => {
            const live = reachable(device);
            const multi = device.zones.filter((z) => z.presets?.length).length > 1;
            return (
              <section key={`${device.id}:${zone.id}`} className="sv-screen">
                <h2 className="sv-title">
                  {multi ? zone.label : device.label}
                  {multi && <span className="sv-sub">{device.label}</span>}
                  {!live && <span className="sv-state">{device.status === "powered-off" ? "off" : "unavailable"}</span>}
                </h2>
                <div className={`sv-grid${zone.canvas ? "" : " sv-grid-plain"}`}>
                  {zone.presets!.map((p) => {
                    const active = zone.activePreset === p.id;
                    const key = `${device.id}:${zone.id}:${p.id}`;
                    return (
                      <button
                        key={p.id}
                        className={`sv-tile${active ? " active" : ""}${pending === key ? " pending" : ""}`}
                        disabled={!live}
                        onClick={() => void pick(device, zone, p.id)}
                      >
                        {zone.canvas && <PresetThumb preset={p} canvas={zone.canvas} colors={colors} />}
                        <span className="sv-name">
                          {p.name}
                          {active && <span className="sv-live">Live</span>}
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
