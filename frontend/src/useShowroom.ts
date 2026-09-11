import { useEffect, useRef, useState, useCallback } from "react";
import type { ServerMessage, AppState } from "@excontrol/shared";

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

/** Subscribes to /ws, keeps a live AppState, auto-reconnects. */
export function useShowroom(): Hook {
  const [state, setState] = useState<AppState | null>(null);
  const [connected, setConnected] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const retry = useRef(0);

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
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => {
        retry.current = 0;
        setConnected(true);
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
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
  }, [pushToast]);

  return { state, connected, toasts, dismiss };
}
