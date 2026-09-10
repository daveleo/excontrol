import type { DeviceState, DeviceType } from "@excontrol/shared";
import type { AppConfig, DeviceConfig } from "../config.js";
import type { Driver } from "../drivers/types.js";
import { NovastarHDriver } from "../drivers/novastar-h.js";
import { NovastarCoexDriver } from "../drivers/novastar-mx40.js";
import { EpsDriver } from "../drivers/eps.js";
import { ObsDriver } from "../drivers/obs.js";
import { store } from "./state.js";
import { bus } from "./bus.js";
import { recomputePower } from "./power.js";
import { log } from "../logger.js";

function build(cfg: DeviceConfig): Driver {
  switch (cfg.type) {
    case "novastar-h": return new NovastarHDriver(cfg);
    case "novastar-coex": return new NovastarCoexDriver(cfg);
    case "expromo-eps": return new EpsDriver(cfg);
    case "obs": return new ObsDriver(cfg);
  }
}

const drivers = new Map<string, Driver>();

export function getDriver(id: string): Driver | undefined {
  return drivers.get(id);
}
export function allDrivers(): Driver[] {
  return [...drivers.values()];
}
export function driversByType(type: DeviceType): Driver[] {
  return allDrivers().filter((d) => d.type === type);
}

export async function startDevices(cfg: AppConfig): Promise<void> {
  const seed: DeviceState[] = cfg.devices.map((d) => ({
    id: d.id,
    type: d.type,
    label: d.label,
    status: d.enabled ? "connecting" : "offline",
    poweredBy: d.poweredBy ?? null,
    zones: [],
  }));
  store.init(seed);

  for (const d of cfg.devices) {
    if (!d.enabled) {
      log.info({ id: d.id }, "device disabled in config, skipping");
      continue;
    }
    const drv = build(d);
    drivers.set(d.id, drv);
    drv.start().catch((e) => log.error({ id: d.id, err: e }, "driver failed to start"));
  }
}

export async function stopDevices(): Promise<void> {
  await Promise.allSettled(allDrivers().map((d) => d.stop()));
  drivers.clear();
}

/** Tear down every driver and bring the set back up from a new config (setup wizard save). */
export async function restartDevices(cfg: AppConfig): Promise<void> {
  log.info({ devices: cfg.devices.map((d) => d.id) }, "restarting devices after config change");
  await stopDevices();
  await startDevices(cfg);
  recomputePower();
  bus.emit("broadcast", { t: "snapshot", state: store.snapshot() });
}
