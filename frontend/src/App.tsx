import { useEffect, useState } from "react";
import { useShowroom } from "./useShowroom.js";
import { DeviceCard } from "./components/DeviceCard.js";
import { PowerBanner } from "./components/PowerBanner.js";
import { PresetsPanel } from "./components/PresetsPanel.js";
import { SchedulerPanel } from "./components/SchedulerPanel.js";
import { ScheduleCard } from "./components/ScheduleCard.js";
import { ShutdownModal } from "./components/ShutdownModal.js";
import { SetupWizardLoader } from "./components/SetupWizard.js";
import { UnlockModal } from "./components/UnlockModal.js";
import { verifyToken } from "./api.js";
import { ensureUnlocked } from "./lib/unlock.js";

export function App() {
  const { state, connected, toasts, dismiss } = useShowroom();
  const [panel, setPanel] = useState<null | "presets" | "schedule" | "devices">(null);
  const [firstRunUnlocked, setFirstRunUnlocked] = useState(false);

  const scheduleCount = state?.schedule.entries.filter((e) => e.enabled).length ?? 0;
  const domainLevel = (deviceId: string) =>
    state?.powerDomains.find((d) => d.members.includes(deviceId))?.level;

  const firstRun = !!state && !state.app.configured;
  const locked = state?.app.settingsLocked ?? false;
  const epsOff = new Set(
    (state?.powerDomains ?? []).filter((d) => d.level === "off").map((d) => d.id),
  );

  // A password can be set from a previous configuration that has since lost all its
  // devices — don't let that strand the operator outside a wizard they can't reach.
  const firstRunLockedOut = firstRun && locked && !firstRunUnlocked;
  useEffect(() => {
    if (!firstRunLockedOut) return;
    void ensureUnlocked(true, verifyToken).then((ok) => ok && setFirstRunUnlocked(true));
  }, [firstRunLockedOut]);

  const openDevices = async () => {
    if (panel === "devices") return setPanel(null);
    if (!(await ensureUnlocked(locked, verifyToken))) return;
    setPanel("devices");
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" data-on={connected} title={connected ? "connected" : "reconnecting…"} />
          {state?.app.name ?? "eXcontrol"}
        </div>
        <div className="toolbar">
          <button className="text-btn" disabled={!state} onClick={openDevices}>
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

      {firstRun && firstRunLockedOut && (
        <p className="loading">This install has a settings password — unlock it to continue setup.</p>
      )}
      {firstRun && !firstRunLockedOut && <SetupWizardLoader onClose={() => setPanel(null)} epsOff={epsOff} />}

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

      <UnlockModal />

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
