import { useState } from "react";
import type { PowerDomain } from "@excontrol/shared";
import { ALWAYS_ON_DOMAIN } from "@excontrol/shared";
import { power } from "../api.js";

/** Plain-language power state, one row per EPS. Hidden when everything is quietly ON. */
export function PowerBanner({ domains }: { domains: PowerDomain[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const eps = domains.filter((d) => d.id !== ALWAYS_ON_DOMAIN);
  const notable = eps.filter((d) => d.level !== "on" || d.detail);
  if (!notable.length) return null;

  const act = async (target: string, on: boolean) => {
    setBusy(target);
    try { await power(target, on); } catch { /* toast from server */ } finally { setBusy(null); }
  };

  return (
    <div className="power-banner">
      {notable.map((d) => (
        <div key={d.id} className={`pb-row ${d.level}`}>
          <div className="pb-text">
            <div className="pb-headline">{d.headline}</div>
            {d.detail && <div className="pb-detail">{d.detail}</div>}
          </div>
          {(d.level === "off" || d.level === "unknown") && (
            <button className="pb-action" disabled={busy === d.id} onClick={() => act(d.id, true)}>
              Power On
            </button>
          )}
          {d.level === "starting" && <div className="pb-spinner" aria-hidden />}
        </div>
      ))}
    </div>
  );
}
