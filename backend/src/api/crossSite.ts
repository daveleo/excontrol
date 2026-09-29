import type { IncomingHttpHeaders } from "node:http";

/**
 * True when a *browser* says this request comes from another site — cross-site request
 * forgery against /api, or cross-site WebSocket hijacking of /ws.
 *
 * Found in testing: with no access password (the default), a page on any website opened by
 * anyone on the LAN could POST /api/power/all/off (a "simple" bodyless request needs no CORS
 * preflight) and switch the room off, and could open /ws (no CORS for WebSockets) to read the
 * whole live state.
 *
 * Browsers mark every request with Sec-Fetch-Site (and cross-origin ones with Origin).
 * Non-browser clients — Bitfocus Companion, curl, scripts — send neither and stay allowed,
 * so existing integrations keep working.
 */
export function isCrossSite(h: IncomingHttpHeaders): boolean {
  const site = h["sec-fetch-site"];
  if (site === "same-origin" || site === "none") return false;
  const origin = h.origin;
  if (origin === "null") return true; // sandboxed iframe, file:// page, data: URL
  if (origin) {
    try {
      return new URL(origin).host !== h.host;
    } catch {
      return true;
    }
  }
  return site === "cross-site" || site === "same-site";
}
