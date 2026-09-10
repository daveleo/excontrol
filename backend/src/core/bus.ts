import { EventEmitter } from "node:events";
import type { DeviceState, ServerMessage } from "@excontrol/shared";

/** Partial patch a driver pushes up; id is required, the rest is merged. */
export type DevicePatch = Partial<DeviceState> & { id: string };

interface Events {
  "device:patch": [DevicePatch];
  broadcast: [ServerMessage];
}

class Bus extends EventEmitter {
  override emit<K extends keyof Events>(event: K, ...args: Events[K]): boolean {
    return super.emit(event, ...args);
  }
  override on<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  override off<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }
}

export const bus = new Bus();

export function toast(level: "info" | "warn" | "error", text: string): void {
  bus.emit("broadcast", { t: "toast", level, text });
}
