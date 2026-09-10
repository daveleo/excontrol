import { useState } from "react";
import { useShowroom } from "./useShowroom.js";
import { DeviceCard } from "./components/DeviceCard.js";
import { PowerBanner } from "./components/PowerBanner.js";
import { PresetsPanel } from "./components/PresetsPanel.js";
import { SchedulerPanel } from "./components/SchedulerPanel.js";
import { ScheduleCard } from "./components/ScheduleCard.js";
import { ShutdownModal } from "./components/ShutdownModal.js";
import { SetupWizardLoader } from "./components/SetupWizard.js";

export function App() {
  const { state, connected, toasts, dismiss } = useShowroom();
  const [panel, setPanel] = useState<null | "presets" | "schedule" | "devices">(null);

  const scheduleCount = state?.schedule.entries.filter((e) => e.enabled).length ?? 0;
  const domainLevel = (deviceId: string) =>
    state?.powerDomains.find((d) => d.members.includes(deviceId))?.level;

  const firstRun = !!state && !state.app.configured;
  const epsOff = new Set(
    (state?.powerDomains ?? []).filter((d) => d.level === "off").map((d) => d.id),
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" data-on={connected} title={connected ? "connected" : "reconnecting…"} />
          {state?.app.name ?? "eXcontrol"}
        </div>
        <div className="toolbar">
          <button
            className="text-btn"
            disabled={!state}
            onClick={() => setPanel(panel === "devices" ? null : "devices")}
          >
            Devices
          </button>
          <button
            className="text-btn"
            disabled={!state || firstRun}
            onClick={() => setPanel(panel === "presets" ? null : "presets")}
          >
            Presets
          </button>
          <button
            className="icon-btn"
            title="Scheduler"
            aria-label="Scheduler"
            disabled={firstRun}
            onClick={() => setPanel(panel === "schedule" ? null : "schedule")}
          >
            <ClockIcon />
            {scheduleCount > 0 && <span className="badge">{scheduleCount}</span>}
          </button>
          {state && <span className="build">v{state.app.version}</span>}
        </div>
      </header>

      {!state && <p className="loading">Connecting…</p>}

      {firstRun && <SetupWizardLoader onClose={() => setPanel(null)} epsOff={epsOff} />}

      {state && !firstRun && (
        <>
          <PowerBanner domains={state.powerDomains} />

          <main className="grid">
            {state.devices.map((d) => (
              <DeviceCard key={d.id} device={d} powerLevel={domainLevel(d.id)} />
            ))}
            {(state.schedule.entries.length > 0 || scheduleCount > 0) && (
              <ScheduleCard schedule={state.schedule} />
            )}
          </main>

          <ShutdownModal schedule={state.schedule} />
          {panel === "presets" && <PresetsPanel state={state} onClose={() => setPanel(null)} />}
          {panel === "schedule" && <SchedulerPanel state={state} onClose={() => setPanel(null)} />}
        </>
      )}

      {state && !firstRun && panel === "devices" && <SetupWizardLoader onClose={() => setPanel(null)} epsOff={epsOff} />}

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

function ClockIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" strokeLinecap="round" />
    </svg>
  );
}
