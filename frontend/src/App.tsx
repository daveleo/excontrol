import { useState } from "react";
import { useShowroom } from "./useShowroom.js";
import { DeviceCard } from "./components/DeviceCard.js";
import { PowerBanner } from "./components/PowerBanner.js";
import { PresetsPanel } from "./components/PresetsPanel.js";
import { SchedulerPanel } from "./components/SchedulerPanel.js";
import { ScheduleCard } from "./components/ScheduleCard.js";
import { ShutdownModal } from "./components/ShutdownModal.js";

export function App() {
  const { state, connected, toasts, dismiss } = useShowroom();
  const [panel, setPanel] = useState<null | "presets" | "schedule">(null);

  const scheduleCount = state?.schedule.entries.filter((e) => e.enabled).length ?? 0;
  const domainLevel = (deviceId: string) =>
    state?.powerDomains.find((d) => d.members.includes(deviceId))?.level;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" data-on={connected} title={connected ? "connected" : "reconnecting…"} />
          {state?.app.name ?? "eXcontrol"}
        </div>
        <div className="toolbar">
          <button className="text-btn" disabled={!state} onClick={() => setPanel(panel === "presets" ? null : "presets")}>
            Presets
          </button>
          <button
            className="icon-btn"
            title="Scheduler"
            aria-label="Scheduler"
            onClick={() => setPanel(panel === "schedule" ? null : "schedule")}
          >
            <ClockIcon />
            {scheduleCount > 0 && <span className="badge">{scheduleCount}</span>}
          </button>
          {state && <span className="build">v{state.app.version}</span>}
        </div>
      </header>

      {!state && <p className="loading">Connecting…</p>}

      {state && !state.app.configured && (
        <div className="setup-needed">
          <h2>No devices configured yet</h2>
          <p>Add your NovaStar controllers, EPS units and OBS in <code>excontrol.config.json</code> (the
          setup wizard lands next). See <code>config/excontrol.config.example.json</code>.</p>
        </div>
      )}

      {state && <PowerBanner domains={state.powerDomains} />}

      <main className="grid">
        {state?.devices.map((d) => (
          <DeviceCard key={d.id} device={d} powerLevel={domainLevel(d.id)} />
        ))}
        {state && (state.schedule.entries.length > 0 || scheduleCount > 0) && (
          <ScheduleCard schedule={state.schedule} />
        )}
      </main>

      {state && <ShutdownModal schedule={state.schedule} />}
      {state && panel === "presets" && <PresetsPanel state={state} onClose={() => setPanel(null)} />}
      {state && panel === "schedule" && <SchedulerPanel state={state} onClose={() => setPanel(null)} />}

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
