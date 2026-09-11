import { useEffect, useRef, useState, useCallback } from "react";
import type { ServerMessage, AppState } from "@excontrol/shared";
import { getToken } from "./lib/auth.js";

export interface Toast {
  id: number;
  level: "info" | "warn" | "error";
  text: string;
}

interface Hook {
  state: AppState | null;
  connected: boolean;
  toasts: Toast[];
  dismiss: (id: number) => void;
}

let toastSeq = 0;

/** Subscribes to /ws, keeps a live AppState, auto-reconnects. `onUnauthorized` fires if the
 *  very first connection attempt is rejected outright — the token was verified over REST
 *  right before this mounted, so that almost certainly means it's since been revoked
 *  (password changed elsewhere) rather than a normal network blip. */
export function useShowroom(onUnauthorized?: () => void): Hook {
  const [state, setState] = useState<AppState | null>(null);
  const [connected, setConnected] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const retry = useRef(0);
  const everOpened = useRef(false);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const pushToast = useCallback((level: Toast["level"], text: string) => {
    const id = ++toastSeq;
    setToasts((t) => [...t, { id, level, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout>;
    let closed = false;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const token = getToken();
      const q = token ? `?token=${encodeURIComponent(token)}` : "";
      ws = new WebSocket(`${proto}://${location.host}/ws${q}`);
      let opened = false;
      ws.onopen = () => {
        opened = true;
        everOpened.current = true;
        retry.current = 0;
        setConnected(true);
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        if (!opened && !everOpened.current) {
          onUnauthorized?.();
          return; // don't keep retrying a handshake that's actively being rejected
        }
        retry.current = Math.min(retry.current + 1, 6);
        timer = setTimeout(connect, 500 * 2 ** (retry.current - 1));
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as ServerMessage;
        setState((prev) => {
          if (msg.t === "snapshot") return msg.state;
          if (!prev) return prev;
          switch (msg.t) {
            case "device":
              return { ...prev, devices: prev.devices.map((d) => (d.id === msg.device.id ? msg.device : d)) };
            case "power":
              return { ...prev, powerDomains: msg.domains };
            case "presets":
              return { ...prev, presets: msg.presets };
            case "schedule":
              return { ...prev, schedule: msg.schedule };
            case "update":
              return { ...prev, updateInfo: msg.info };
            default:
              return prev;
          }
        });
        if (msg.t === "reload") location.reload();
        if (msg.t === "toast") pushToast(msg.level, msg.text);
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [pushToast, onUnauthorized]);

  return { state, connected, toasts, dismiss };
}
