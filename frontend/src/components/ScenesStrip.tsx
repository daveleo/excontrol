import { useState } from "react";
import type { AppState } from "@excontrol/shared";
import { applyPreset } from "../api.js";

/** Saved looks across devices ("Scenes"), one tap each. The star marks the one applied
 *  automatically when the power comes on. Editing lives in Setup › Scenes. */
export function ScenesStrip({ state }: { state: AppState }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  if (!state.presets.length) return null;
  const run = async (id: string) => {
    setBusy(id);
    try {
      await applyPreset(id);
      setDone(id);
      setTimeout(() => setDone((d) => (d === id ? null : d)), 1800);
    } catch { /* toast */ } finally { setBusy(null); }
  };
  return (
    <section className="scenes" aria-label="Scenes">
      <span className="scenes-label">Scenes</span>
      {state.presets.map((p) => (
        <button
          key={p.id}
          className={`scene-chip ${done === p.id ? "done" : ""}`}
          disabled={busy === p.id}
          onClick={() => void run(p.id)}
          title={p.powerOnDefaultFor ? "Applied automatically when the power comes on" : undefined}
        >
          {p.powerOnDefaultFor && <span className="star" aria-label="startup scene">★</span>}
          {busy === p.id ? "Applying…" : done === p.id ? "Applied ✓" : p.label}
        </button>
      ))}
    </section>
  );
}
