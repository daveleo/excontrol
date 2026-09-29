/** Kiosk mode — the appliance's own local display (Pi: cage + Chromium, launched by
 *  pi/kiosk.sh with `?kiosk=1`). Browsers on the network never get it. The query string is
 *  carried across port-change navigations, so the flag survives a rebind. */
export const IS_KIOSK = new URLSearchParams(location.search).get("kiosk") === "1";

/** Last pointer kind the user touched the screen with — the on-screen keyboard only opens
 *  for touch; someone with a mouse attached normally has a keyboard too. */
export let lastPointerType: string = "touch";

/** Kiosk-wide behaviour that is not a component: cursor only while a real mouse is in use,
 *  no browser gestures (pinch-zoom, long-press menu, drag-out of links/images).
 *  The Pi's cursor theme is fully transparent (pi/kiosk.sh), so the visible arrow in mouse
 *  mode is the CSS image in `.kiosk-mouse` — the theme can't show one by accident. */
export function initKiosk(): void {
  if (!IS_KIOSK) return;
  const root = document.documentElement;
  root.classList.add("kiosk", "kiosk-no-cursor");

  const onPointer = (e: PointerEvent) => {
    lastPointerType = e.pointerType;
    const mouse = e.pointerType === "mouse";
    root.classList.toggle("kiosk-mouse", mouse);
    root.classList.toggle("kiosk-no-cursor", !mouse);
  };
  window.addEventListener("pointerdown", onPointer, { capture: true, passive: true });
  window.addEventListener("pointermove", onPointer, { capture: true, passive: true });

  // Belt and braces with Chromium's --disable-pinch: no ctrl+wheel / trackpad zoom either.
  window.addEventListener("wheel", (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
  document.addEventListener("gesturestart", (e) => e.preventDefault());
  document.addEventListener("contextmenu", (e) => e.preventDefault());
  document.addEventListener("dragstart", (e) => e.preventDefault());
}
