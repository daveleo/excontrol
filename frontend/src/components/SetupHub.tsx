import { useCallback, useEffect, useState } from "react";
import type { AppState, SetupState } from "@excontrol/shared";
import { getSetupState } from "../api.js";
import { SetupWizard } from "./SetupWizard.js";
import { GroupsEditor } from "./GroupsEditor.js";
import { ScenesEditor } from "./ScenesEditor.js";
import { SystemSection, SecurityPassword, BackupSection } from "./SettingsSections.js";

type Section = "devices" | "groups" | "scenes" | "system" | "access" | "backup";

const SECTIONS: { id: Section; label: string; blurb: string }[] = [
  { id: "devices", label: "Devices", blurb: "What this controller talks to" },
  { id: "groups", label: "Groups", blurb: "Screens you switch together" },
  { id: "scenes", label: "Scenes", blurb: "Saved looks, one tap each" },
  { id: "system", label: "System", blurb: "Room name, port, updates" },
  { id: "access", label: "Access", blurb: "Password for this panel" },
  { id: "backup", label: "Backup", blurb: "Export, import, diagnostics" },
];

/** Every piece of configuration in one place — the operator's dashboard stays clean. */
export function SetupHub({ state, onClose, epsOff }: { state: AppState; onClose: () => void; epsOff: Set<string> }) {
  const [section, setSection] = useState<Section>("devices");
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [locked, setLocked] = useState(state.app.settingsLocked);
  const [devicesDirty, setDevicesDirty] = useState(false);
  const onDirty = useCallback((d: boolean) => setDevicesDirty(d), []);

  useEffect(() => {
    getSetupState().then(setSetup).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const leaveDevicesOk = () => !devicesDirty || confirm("You have unsaved device changes. Leave without saving?");
  const go = (s: Section) => {
    if (s === section) return;
    if (section === "devices" && !leaveDevicesOk()) return;
    setSection(s);
  };
  const close = () => {
    if (section === "devices" && !leaveDevicesOk()) return;
    onClose();
  };

  const current = SECTIONS.find((s) => s.id === section)!;

  return (
    <div className="setup" role="dialog" aria-label="Setup">
      <header className="setup-head">
        <h1>Setup</h1>
        <button className="icon-btn" onClick={close} aria-label="Close setup">✕</button>
      </header>
      <div className="setup-body">
        <nav className="setup-nav" aria-label="Setup sections">
          {SECTIONS.map((s) => (
            <button key={s.id} className={s.id === section ? "active" : ""} onClick={() => go(s.id)} aria-current={s.id === section}>
              <b>{s.label}</b>
              <span>{s.blurb}</span>
            </button>
          ))}
        </nav>
        <main className="setup-main">
          <h2>{current.label}</h2>
          {err && <p className="err">{err}</p>}
          {section === "devices" && (setup
            ? <SetupWizard initial={setup} embedded live={state.devices} epsOff={epsOff} onDirty={onDirty} onClose={() => {}} />
            : <p className="muted">Loading…</p>)}
          {section === "groups" && <GroupsEditor state={state} />}
          {section === "scenes" && <ScenesEditor state={state} />}
          {section === "system" && (setup ? <SystemSection initial={setup} version={state.app.version} /> : <p className="muted">Loading…</p>)}
          {section === "access" && <SecurityPassword locked={locked} onLockedChange={setLocked} />}
          {section === "backup" && <BackupSection locked={locked} />}
        </main>
      </div>
    </div>
  );
}
