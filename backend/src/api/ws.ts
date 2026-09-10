import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { ServerMessage } from "@excontrol/shared";
import { bus } from "../core/bus.js";
import { store } from "../core/state.js";
import { log } from "../logger.js";

/** Attaches a WS endpoint at /ws that streams state to the front-end. */
export function attachWs(server: Server): () => void {
  const wss = new WebSocketServer({ server, path: "/ws" });

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
