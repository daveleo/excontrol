import { useCallback, useEffect, useState } from "react";
import { useShowroom } from "./useShowroom.js";
import { DeviceCard } from "./components/DeviceCard.js";
import { PowerBar } from "./components/PowerBar.js";
import { GroupRows } from "./components/PowerGroups.js";
import { ScenesStrip } from "./components/ScenesStrip.js";
import { PowerStrip } from "./components/PowerStrip.js";
import { SchedulerPanel } from "./components/SchedulerPanel.js";
import { ShutdownModal } from "./components/ShutdownModal.js";
import { SetupWizardLoader } from "./components/SetupWizard.js";
import { SetupHub } from "./components/SetupHub.js";
import { AlertPopup } from "./components/AlertPopup.js";
import { UnlockModal } from "./components/UnlockModal.js";
import { UpdateBanner } from "./components/UpdateBanner.js";
import { ThemeToggle } from "./components/ThemeToggle.js";
import { AccessGate } from "./components/AccessGate.js";
import { BRAND } from "@excontrol/shared";
import { isDisplay } from "./lib/status.js";
import { useNarrow } from "./lib/useNarrow.js";
import { authStatus, verifyToken } from "./api.js";
import { ensureUnlocked } from "./lib/unlock.js";

/**
 * Once a password is set, nothing below renders until it's satisfied — the whole control
 * surface is gated, not just settings, so an unauthenticated visitor can't see or operate
 * the room at all. `GET /api/auth/status` is the one thing that stays open regardless
 * (how else would the page know whether to show the gate?).
 */
export function App() {
  const [authPhase, setAuthPhase] = useState<"checking" | "locked" | "open">("checking");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await authStatus();
        if (!status.locked) {
          if (!cancelled) setAuthPhase("open");
          return;
        }
        const valid = await verifyToken();
        if (!cancelled) setAuthPhase(valid ? "open" : "locked");
      } catch {
        // Can't reach the server at all yet — Dashboard's own "Connecting…" state handles
        // that; don't strand the operator behind a gate check that never resolved.
        if (!cancelled) setAuthPhase("open");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleUnauthorized = useCallback(() => setAuthPhase("locked"), []);

  if (authPhase === "checking") {
    return (
      <div className="app">
        <p className="loading">Connecting…</p>
      </div>
    );
  }
  if (authPhase === "locked") {
    return <AccessGate onUnlocked={() => setAuthPhase("open")} />;
  }
  return <Dashboard onUnauthorized={handleUnauthorized} />;
}

function Dashboard({ onUnauthorized }: { onUnauthorized: () => void }) {
  const { state, connected, toasts, dismiss } = useShowroom(onUnauthorized);
  const [panel, setPanel] = useState<null | "schedule" | "setup">(null);
  const narrow = useNarrow();

  const scheduleCount = state?.schedule.entries.filter((e) => e.enabled).length ?? 0;
  const firstRun = !!state && !state.app.configured;
  const locked = state?.app.settingsLocked ?? false;
  const epsOff = new Set((state?.powerDomains ?? []).filter((d) => d.level === "off").map((d) => d.id));

  const openSetup = async () => {
    if (panel === "setup") return setPanel(null);
    if (!(await ensureUnlocked(locked, verifyToken))) return;
    setPanel("setup");
  };

  const target = (id: string) => state?.deviceTargets?.find((t) => t.deviceId === id);
  const displays = state?.devices.filter(isDisplay) ?? [];
  const sources = state?.devices.filter((d) => !isDisplay(d) && d.type !== "expromo-eps") ?? [];

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" data-on={connected} title={connected ? "connected" : "reconnecting…"} />
          {BRAND.name}
        </div>
        <div className="toolbar">
          <button className="icon-text-btn" title="Schedule" disabled={!state || firstRun} onClick={() => setPanel(panel === "schedule" ? null : "schedule")}>
            <ClockIcon />
            <span className="btn-label">Schedule</span>
            {scheduleCount > 0 && <span className="badge">{scheduleCount}</span>}
          </button>
          <button className="icon-text-btn" title="Setup" disabled={!state} onClick={() => void openSetup()}>
            <GearIcon />
            <span className="btn-label">Setup</span>
          </button>
          <ThemeToggle />
        </div>
      </header>

      {!state && <p className="loading">Connecting…</p>}
      {state && !connected && <div className="reconnect">Reconnecting to eXcontrol…</div>}

      {state?.updateInfo && <UpdateBanner info={state.updateInfo} />}

      {firstRun && <SetupWizardLoader onClose={() => setPanel(null)} epsOff={epsOff} />}

      {state && !firstRun && (
        <>
          <PowerBar state={state} />
          <GroupRows state={state} />
          <ScenesStrip state={state} />

          <main className="grid">
            {displays.map((d) => <DeviceCard key={d.id} device={d} target={target(d.id)} narrow={narrow} />)}
            {sources.map((d) => <DeviceCard key={d.id} device={d} target={target(d.id)} narrow={narrow} />)}
          </main>

          <PowerStrip state={state} />

          <ShutdownModal schedule={state.schedule} state={state} />
          {panel === "schedule" && <SchedulerPanel state={state} onClose={() => setPanel(null)} />}
          {panel === "setup" && <SetupHub state={state} epsOff={epsOff} onClose={() => setPanel(null)} />}
          <AlertPopup alerts={state.alerts ?? []} />
        </>
      )}

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
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" strokeLinecap="round" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.5-2-3.5-2.4 1a7.6 7.6 0 0 0-1.7-1L14.9 3h-4l-.4 2.5a7.6 7.6 0 0 0-1.7 1l-2.4-1-2 3.5 2 1.5a7.6 7.6 0 0 0 0 2l-2 1.5 2 3.5 2.4-1a7.6 7.6 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.6 7.6 0 0 0 1.7-1l2.4 1 2-3.5-2-1.5Z" strokeLinejoin="round" />
    </svg>
  );
}
