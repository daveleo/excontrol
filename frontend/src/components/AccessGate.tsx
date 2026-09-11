import { useRef, useState } from "react";
import { login } from "../api.js";

/**
 * The whole page behind this — device state, control, everything — is gated on a valid
 * token once a password is set. Nothing about the room renders until this resolves.
 */
export function AccessGate({ onUnlocked }: { onUnlocked: () => void }) {
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await login(password);
      onUnlocked();
    } catch {
      setErr("Incorrect password.");
      setPassword("");
      setTimeout(() => inputRef.current?.focus(), 10);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="access-gate">
      <form className="access-gate-card" onSubmit={submit}>
        <h1>eXcontrol</h1>
        <p>This control panel is locked. Enter the password to view or operate it.</p>
        <input
          ref={inputRef}
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoComplete="current-password"
        />
        {err && <p className="err">{err}</p>}
        <button type="submit" className="primary" disabled={busy || !password}>
          {busy ? "Checking…" : "Unlock"}
        </button>
      </form>
    </div>
  );
}
