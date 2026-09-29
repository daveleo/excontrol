import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

/** The customer view (`?view=simple`) vs the standard dashboard. */
export const IS_SIMPLE_VIEW = new URLSearchParams(location.search).get("view") === "simple";

/** Swap views, keeping every other flag (e.g. `kiosk=1`). */
export function switchView(): void {
  const q = new URLSearchParams(location.search);
  if (q.get("view") === "simple") q.delete("view");
  else q.set("view", "simple");
  location.search = q.toString();
}

/** Press and hold — the presenter's hidden way between the two views. Nothing to see for a
 *  customer; a normal tap does nothing. `holding` drives a subtle progress hint. */
export function useHold(onHold: () => void, ms = 2000) {
  const timer = useRef<number | undefined>(undefined);
  const [holding, setHolding] = useState(false);
  const cancel = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = undefined;
    setHolding(false);
  };
  const start = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    cancel();
    setHolding(true);
    timer.current = window.setTimeout(() => {
      setHolding(false);
      onHold();
    }, ms);
  };
  return {
    holding,
    bind: {
      onPointerDown: start,
      onPointerUp: cancel,
      onPointerLeave: cancel,
      onPointerCancel: cancel,
      onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
    },
  };
}
