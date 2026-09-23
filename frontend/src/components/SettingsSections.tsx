import { useEffect, useRef, useState } from "react";
import type { SetupState } from "@excontrol/shared";
import { Modal } from "./Modal.js";
import {
  getSetupState, saveAppSettings, checkForUpdates, setSettingsPassword, login, verifyToken,
  exportConfig, importConfig, downloadDiagnostics,
} from "../api.js";
import { ensureUnlocked } from "../lib/unlock.js";

/** Fetches the current app settings on demand and renders the panel. Separate from Devices
 *  — this is the machine-level stuff (name, port, autostart, access password, backup),
 *  not device configuration, and gets its own gear icon so it isn't buried in Devices. */
export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<SetupState | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    getSetupState().then(setState).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  if (err) {
    return (
      <Modal title="Settings" onClose={onClose}>
        <p className="probe-bad">{err}</p>
      </Modal>
    );
  }
  if (!state) {
    return (
      <Modal title="Settings" onClose={onClose}>
        <p className="muted">Loading…</p>
      </Modal>
    );
  }
  return <SettingsForm initial={state} onClose={onClose} />;
}

function SettingsForm({ initial, onClose }: { initial: SetupState; onClose: () => void }) {
  const [name, setName] = useState(initial.app.name);
  const [httpPort, setHttpPort] = useState(initial.app.httpPort);
  const [locked, setLocked] = useState(initial.settingsLocked);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState<number | null>(null);

  const save = async () => {
    setSaving(true);
    setSaveErr(null);
    try {
      const res = await saveAppSettings({ name, httpPort });
      if (res.portChanged) {
        setReconnecting(res.port);
        followToPort(res.port);
        return; // don't close — we're about to navigate away
      }
      onClose();
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  /** The server rebinds to the new port a moment after responding — poll for it, then follow. */
  const followToPort = (port: number) => {
    const target = `${location.protocol}//${location.hostname}:${port}/`;
    const tryOnce = (attempt: number) => {
      fetch(`${location.protocol}//${location.hostname}:${port}/health`, { signal: AbortSignal.timeout(1500) })
        .then(() => (location.href = target))
        .catch(() => (attempt < 15 ? setTimeout(() => tryOnce(attempt + 1), 500) : (location.href = target)));
    };
    setTimeout(() => tryOnce(0), 500);
  };

  if (reconnecting != null) {
    return (
      <Modal title="Settings" onClose={() => {}}>
        <p className="loading">Saved. Reconnecting on port {reconnecting}…</p>
      </Modal>
    );
  }

  return (
    <Modal title="Settings" onClose={onClose}>
      <div className="wiz-app-grid">
        <label className="field">
          <span>Display name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field narrow">
          <span>Port</span>
          <input type="number" value={httpPort} onChange={(e) => setHttpPort(Number(e.target.value) || httpPort)} />
        </label>
        <p className="muted small wiz-app-note">
          The control panel's address on this network, e.g. <code>http://&lt;this-PC&apos;s-IP&gt;:{httpPort}</code>.
          Changing the port reconnects everyone automatically.
        </p>
      </div>
      {saveErr && <p className="err">{saveErr}</p>}
      <div className="modal-actions">
        <button className="primary" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save"}</button>
      </div>

      <AutoStartToggle initial={initial.app.autoStart} />
      <CheckForUpdates />
      <SecurityPassword locked={locked} onLockedChange={setLocked} />
      <BackupSection locked={locked} />
    </Modal>
  );
}

function AutoStartToggle({ initial }: { initial: boolean }) {
  const [enabled, setEnabled] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggle = async (v: boolean) => {
    setEnabled(v); // optimistic — this is a plain OS setting, not something worth a Save button
    setBusy(true);
    setErr(null);
    try {
      await saveAppSettings({ autoStart: v });
    } catch (e) {
      setEnabled(!v);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wiz-security">
      <label className="toggle">
        <input type="checkbox" checked={enabled} disabled={busy} onChange={(e) => void toggle(e.target.checked)} />
        Start eXcontrol when Windows starts
      </label>
      {err && <span className="probe-bad">{err}</span>}
      <p className="hint muted">
        Launches automatically when you log into this Windows account. Desktop app only — has
        no effect running from source.
      </p>
    </div>
  );
}

function CheckForUpdates() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const run = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await checkForUpdates();
      setMsg(
        r.triggered
          ? { ok: true, text: "Checking… a banner appears here, or a dialog on this PC, if a newer version is available." }
          : { ok: false, text: "Not available outside the installed desktop app." },
      );
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wiz-security">
      <div className="wd-zones-head">
        <span>Updates</span>
        <span className="muted small">Checks the public GitHub Releases feed for a newer version.</span>
      </div>
      <div className="row">
        <button onClick={() => void run()} disabled={busy}>{busy ? "Checking…" : "Check for updates"}</button>
      </div>
      {msg && <span className={msg.ok ? "probe-ok" : "probe-bad"}>{msg.text}</span>}
    </div>
  );
}

function SecurityPassword({ locked, onLockedChange }: { locked: boolean; onLockedChange: (locked: boolean) => void }) {
  const [mode, setMode] = useState<null | "set" | "change" | "remove">(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const reset = () => { setMode(null); setCurrent(""); setNext(""); setConfirm(""); };

  const submit = async () => {
    if (mode === "remove") {
      if (!current) return setMsg({ ok: false, text: "Enter the current password to remove it." });
    } else if (!next || next !== confirm) {
      return setMsg({ ok: false, text: "New passwords must match and can't be empty." });
    }
    setBusy(true);
    setMsg(null);
    try {
      await setSettingsPassword({
        currentPassword: locked ? current : undefined,
        newPassword: mode === "remove" ? null : next,
      });
      if (mode === "remove") {
        onLockedChange(false);
      } else {
        await login(next); // stay authenticated in this session under the new password
        onLockedChange(true);
      }
      setMsg({ ok: true, text: mode === "remove" ? "Password removed." : "Password saved." });
      reset();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wiz-security">
      <div className="wd-zones-head">
        <span>Access password</span>
        <span className="muted small">
          {locked ? "Set — the whole control panel requires it, on every device." : "Not set — anyone on the network can open and operate this control panel."}
        </span>
      </div>

      {!mode && (
        <div className="row">
          {!locked && <button onClick={() => setMode("set")}>Set a password</button>}
          {locked && <button onClick={() => setMode("change")}>Change password</button>}
          {locked && <button onClick={() => setMode("remove")}>Remove password</button>}
        </div>
      )}

      {mode && (
        <div className="wiz-security-form">
          {locked && (
            <input type="password" placeholder="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          )}
          {mode !== "remove" && (
            <>
              <input type="password" placeholder="New password" value={next} onChange={(e) => setNext(e.target.value)} />
              <input type="password" placeholder="Confirm new password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </>
          )}
          <div className="row">
            <button onClick={reset} disabled={busy}>Cancel</button>
            <button className="primary" onClick={submit} disabled={busy}>
              {busy ? "Saving…" : mode === "remove" ? "Remove" : "Save password"}
            </button>
          </div>
        </div>
      )}
      {msg && <span className={msg.ok ? "probe-ok" : "probe-bad"}>{msg.text}</span>}
      <p className="hint muted">
        Locks the entire control panel — viewing state, brightness, blackout, power, presets, the
        schedule, everything — not just this Settings screen. Anyone without the password sees a
        login prompt and nothing else.
      </p>
    </div>
  );
}

function BackupSection({ locked }: { locked: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const run = (key: string, fn: () => Promise<void>) => async () => {
    if (!(await ensureUnlocked(locked, verifyToken))) return;
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      if (key !== "import") setMsg({ ok: true, text: "Downloaded." });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const onImportFile = run("import", async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    const parsed: unknown = JSON.parse(await file.text());
    const res = await importConfig(parsed);
    if (res.portChanged) {
      setMsg({ ok: true, text: `Imported — reconnecting on port ${res.port}…` });
      setTimeout(() => (location.href = `${location.protocol}//${location.hostname}:${res.port}/`), 1200);
    } else {
      setMsg({ ok: true, text: "Imported — reloading…" });
      setTimeout(() => location.reload(), 1000);
    }
  });

  return (
    <div className="wiz-security">
      <div className="wd-zones-head">
        <span>Backup</span>
        <span className="muted small">Move this setup to a new PC, or send diagnostics for support.</span>
      </div>
      <div className="row">
        <button onClick={run("export", exportConfig)} disabled={!!busy}>
          {busy === "export" ? "Exporting…" : "Export config"}
        </button>
        <button onClick={() => fileRef.current?.click()} disabled={!!busy}>
          {busy === "import" ? "Importing…" : "Import config file"}
        </button>
        <button onClick={run("diag", downloadDiagnostics)} disabled={!!busy}>
          {busy === "diag" ? "Preparing…" : "Download diagnostics"}
        </button>
      </div>
      <input
        ref={fileRef} type="file" accept="application/json" hidden
        onChange={(e) => { if (e.target.files?.[0]) void onImportFile(); e.target.value = ""; }}
      />
      {msg && <span className={msg.ok ? "probe-ok" : "probe-bad"}>{msg.text}</span>}
      <p className="hint muted">
        The exported file has device credentials in plain text — keep it somewhere private. Importing
        replaces every device, preset and schedule entry here (this install's access password is kept).
        Diagnostics redacts secrets and is safe to share with support.
      </p>
    </div>
  );
}
