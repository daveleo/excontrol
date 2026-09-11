import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { ServerMessage } from "@excontrol/shared";
import { bus } from "../core/bus.js";
import { store } from "../core/state.js";
import { isSettingsLocked } from "../config.js";
import { verifyToken } from "../core/auth.js";
import { log } from "../logger.js";

/** Attaches a WS endpoint at /ws that streams state to the front-end. Gated the same way
 *  as the REST API: once a password is set, a browser can't even reach the live feed
 *  without a valid token — the login screen is the only thing rendered until then.
 *  Browsers can't set custom headers on a WebSocket handshake, so the token travels as a
 *  query param (`/ws?token=...`) instead of an Authorization header. */
export function attachWs(server: Server): () => void {
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    verifyClient: (info, callback) => {
      if (!isSettingsLocked()) return callback(true);
      const token = new URL(info.req.url ?? "", "http://internal").searchParams.get("token") ?? undefined;
      if (verifyToken(token)) return callback(true);
      callback(false, 401, "locked");
    },
  });

  const send = (ws: WebSocket, msg: ServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  wss.on("connection", (ws) => {
    send(ws, { t: "snapshot", state: store.snapshot() });
    ws.on("error", (e) => log.warn({ err: e }, "ws client error"));
  });

  const onBroadcast = (msg: ServerMessage) => {
    const data = JSON.stringify(msg);
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  };
  bus.on("broadcast", onBroadcast);

  // keepalive
  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }
  }, 30_000);

  return () => {
    clearInterval(ping);
    bus.off("broadcast", onBroadcast);
    wss.close();
  };
}
