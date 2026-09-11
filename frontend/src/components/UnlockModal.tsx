import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal.js";
import { login } from "../api.js";
import { registerUnlockUI, resolveUnlock } from "../lib/unlock.js";

/** Mounted once in App. Any component can trigger it via requestUnlock()/ensureUnlocked(). */
export function UnlockModal() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => registerUnlockUI(setOpen), []);
  useEffect(() => {
    if (open) {
      setPassword("");
      setErr(null);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  if (!open) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await login(password);
      resolveUnlock(true);
    } catch {
      setErr("Incorrect password.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Verify password" onClose={() => resolveUnlock(false)}>
      <form onSubmit={submit} className="unlock-form">
        <p className="modal-lead">Your session needs to re-verify the password to continue.</p>
        <input
          ref={inputRef}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoComplete="current-password"
        />
        {err && <p className="err">{err}</p>}
        <div className="modal-actions">
          <button type="button" onClick={() => resolveUnlock(false)}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || !password}>
            {busy ? "Checking…" : "Unlock"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
