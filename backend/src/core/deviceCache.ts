import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { ZoneState } from "@excontrol/shared";
import { BRAND } from "@excontrol/shared";
import { getDataDir } from "../config.js";
import { log } from "../logger.js";

/**
 * Last-known zone state per device, persisted to disk so it survives a backend restart —
 * not just an in-memory reconnect. Without this, restarting eXcontrol while a controller
 * is unreachable (e.g. the venue's power is off) shows every zone blank until the device
 * comes back, even though we saw its presets/brightness/blackout minutes ago. Purely
 * informational: the frontend is responsible for labelling this as "last known", not live.
 */
interface CachedDevice {
  zones: ZoneState[];
  extra?: Record<string, unknown>;
  lastSeen: number;
}
type DeviceCache = Record<string, CachedDevice>;

const cacheFile = () => join(getDataDir(), `${BRAND.slug}.device-cache.json`);

let cache: DeviceCache = {};
let loaded = false;
let writeTimer: NodeJS.Timeout | undefined;

function load(): DeviceCache {
  if (loaded) return cache;
  loaded = true;
  const file = cacheFile();
  try {
    if (existsSync(file)) cache = JSON.parse(readFileSync(file, "utf8")) as DeviceCache;
  } catch (e) {
    log.warn({ err: e, file }, "device cache unreadable — starting empty");
    cache = {};
  }
  return cache;
}

export function getCachedZones(id: string): ZoneState[] | undefined {
  return load()[id]?.zones;
}
export function getCachedExtra(id: string): Record<string, unknown> | undefined {
  return load()[id]?.extra;
}
export function getCachedLastSeen(id: string): number | undefined {
  return load()[id]?.lastSeen;
}

/** Record a device's last successfully-confirmed read. Debounced to disk — a poll every
 *  few seconds per device shouldn't mean constant disk writes. `extra` covers the EPS's
 *  own SYSTEM/STATE/OUTPUTS fields, which live outside `zones`. */
export function rememberZones(
  id: string,
  zones: ZoneState[],
  lastSeen: number,
  extra?: Record<string, unknown>,
): void {
  if (zones.length === 0 && !extra) return; // nothing worth remembering yet
  load()[id] = { zones, extra, lastSeen };
  scheduleWrite();
}

/** Drop cache entries for devices no longer in the config (removed/renamed). */
export function pruneCache(knownIds: string[]): void {
  const known = new Set(knownIds);
  const c = load();
  let changed = false;
  for (const id of Object.keys(c)) {
    if (!known.has(id)) {
      delete c[id];
      changed = true;
    }
  }
  if (changed) scheduleWrite();
}

function scheduleWrite(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = undefined;
    flushDeviceCache();
  }, 1500);
}

/** Write immediately — used on graceful shutdown so the last poll isn't lost to the debounce. */
export function flushDeviceCache(): void {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = undefined;
  }
  try {
    mkdirSync(getDataDir(), { recursive: true });
    const file = cacheFile();
    const tmp = file + ".tmp";
    writeFileSync(tmp, JSON.stringify(cache, null, 2));
    renameSync(tmp, file);
  } catch (e) {
    log.error({ err: e, file: cacheFile() }, "failed to persist device cache");
  }
}

/** test-only: drop in-memory state so the next access re-reads from disk under whatever
 *  EXCONTROL_DATA_DIR is current — simulates a process restart without an actual restart. */
export function _resetForTest(): void {
  cache = {};
  loaded = false;
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = undefined;
  }
}
