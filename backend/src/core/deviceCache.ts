import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ZoneState } from "@excontrol/shared";
import { BRAND } from "@excontrol/shared";
import { getDataDir } from "../config.js";
import { log } from "../logger.js";
import { writeFileDurable } from "./durableWrite.js";

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
let lazyTimer: NodeJS.Timeout | undefined;
/** A lastSeen-only change is written at most this often. Measured on a Pi: writing on every
 *  poll meant a rewrite every ~2 s (43 000/day) — needless SD-card wear. */
const LASTSEEN_WRITE_MS = 5 * 60_000;

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
  const c = load();
  const prev = c[id];
  const same = !!prev && JSON.stringify(prev.zones) === JSON.stringify(zones) && JSON.stringify(prev.extra) === JSON.stringify(extra);
  c[id] = { zones, extra, lastSeen };
  if (same) scheduleLazyWrite();
  else scheduleWrite();
}

/** Drop cache entries for devices no longer in the config (removed/renamed). */
export function pruneCache(knownIds: string[]): void {
  // No devices configured (first run, or a config that failed to load): pruning would wipe
  // every device's last-known state for nothing — measured after a power-cut test.
  if (knownIds.length === 0) return;
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

function scheduleLazyWrite(): void {
  if (writeTimer || lazyTimer) return;
  lazyTimer = setTimeout(() => {
    lazyTimer = undefined;
    flushDeviceCache();
  }, LASTSEEN_WRITE_MS);
  lazyTimer.unref?.();
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
  if (lazyTimer) {
    clearTimeout(lazyTimer);
    lazyTimer = undefined;
  }
  try {
    mkdirSync(getDataDir(), { recursive: true });
    writeFileDurable(cacheFile(), JSON.stringify(cache, null, 2));
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
  if (lazyTimer) {
    clearTimeout(lazyTimer);
    lazyTimer = undefined;
  }
}
