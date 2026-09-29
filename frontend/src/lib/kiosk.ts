/** Kiosk mode — the appliance's own local display (Pi: cage + Chromium, launched by
 *  pi/kiosk.sh with `?kiosk=1`). Browsers on the network never get it. The query string is
 *  carried across port-change navigations, so the flag survives a rebind. */
export const IS_KIOSK = new URLSearchParams(location.search).get("kiosk") === "1";

/** Last pointer kind the user touched the screen with — the on-screen keyboard only opens
 *  for touch; someone with a mouse attached normally has a keyboard too. */
export let lastPointerType: string = "touch";

/** Kiosk-wide behaviour that is not a component: cursor only while a real mouse is moving,
 *  no browser gestures (pinch-zoom, long-press menu, drag-out of links/images). */
export function initKiosk(): void {
  if (!IS_KIOSK) return;
  const root = document.documentElement;
  root.classList.add("kiosk", "kiosk-no-cursor");

  const onPointer = (e: PointerEvent) => {
    lastPointerType = e.pointerType;
    root.classList.toggle("kiosk-no-cursor", e.pointerType !== "mouse");
  };
  window.addEventListener("pointerdown", onPointer, { capture: true, passive: true });
  window.addEventListener("pointermove", onPointer, { capture: true, passive: true });

  // Belt and braces with Chromium's --disable-pinch: no ctrl+wheel / trackpad zoom either.
  window.addEventListener("wheel", (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
  document.addEventListener("gesturestart", (e) => e.preventDefault());
  document.addEventListener("contextmenu", (e) => e.preventDefault());
  document.addEventListener("dragstart", (e) => e.preventDefault());
}
