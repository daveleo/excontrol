import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { getConfig, saveConfig, isSettingsLocked } from "../config.js";
import { log } from "../logger.js";

/**
 * A single shared password gating the config surface (device setup, preset & schedule
 * editing) on a trusted LAN. Not a multi-user login — one password, in-memory bearer
 * tokens. Zone/power/preset-apply control is never gated here (see http.ts route wiring).
 */
const TOKEN_TTL_MS = 30 * 24 * 3600_000; // 30 days
const tokens = new Map<string, number>(); // token -> expiry ms

export { isSettingsLocked };

const scrypt = promisify(scryptCb);

// scrypt costs ~35-40ms of CPU even on fast hardware. That's synchronous work an attacker
// could otherwise pipeline to stall the whole event loop (and everyone else's brightness
// slider) — scrypt() runs off the main thread in libuv's threadpool, unlike scryptSync().
async function hash(password: string, saltHex: string): Promise<string> {
  const buf = (await scrypt(password, Buffer.from(saltHex, "hex"), 32)) as Buffer;
  return buf.toString("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export async function checkPassword(password: string): Promise<boolean> {
  const cfg = getConfig();
  const { settingsPasswordHash, settingsPasswordSalt } = cfg.app;
  if (!settingsPasswordHash || !settingsPasswordSalt) return false;
  if (typeof password !== "string" || !password) return false;
  try {
    return safeEqualHex(await hash(password, settingsPasswordSalt), settingsPasswordHash);
  } catch {
    return false;
  }
}

/** Set, change or remove the settings password. Throws if `currentPassword` doesn't match
 *  an existing one (removing/changing always requires it; setting the first one doesn't). */
export async function setPassword(newPassword: string | null | undefined, currentPassword?: string): Promise<void> {
  const cfg = getConfig();
  if (isSettingsLocked() && !(await checkPassword(currentPassword ?? ""))) {
    throw new Error("current password is incorrect");
  }
  if (!newPassword) {
    saveConfig({ ...cfg, app: { ...cfg.app, settingsPasswordHash: undefined, settingsPasswordSalt: undefined } });
    tokens.clear();
    log.info({}, "settings password removed");
    return;
  }
  const salt = randomBytes(16).toString("hex");
  const h = await hash(newPassword, salt);
  saveConfig({ ...cfg, app: { ...cfg.app, settingsPasswordSalt: salt, settingsPasswordHash: h } });
  tokens.clear(); // old sessions no longer apply once the password changes
  log.info({}, "settings password set");
}

export function issueToken(): string {
  const t = randomBytes(24).toString("hex");
  tokens.set(t, Date.now() + TOKEN_TTL_MS);
  return t;
}

export function verifyToken(token: string | undefined): boolean {
  if (!token) return false;
  const exp = tokens.get(token);
  if (exp === undefined) return false;
  if (exp < Date.now()) {
    tokens.delete(token);
    return false;
  }
  return true;
}

export function bearerFrom(header: string | string[] | undefined): string | undefined {
  const h = Array.isArray(header) ? header[0] : header;
  return h?.startsWith("Bearer ") ? h.slice(7) : undefined;
}

/* ---------- login rate limiting ----------
 * Keyed by client IP. Not about stopping a determined attacker (the password is a shared
 * LAN convenience lock, not a security boundary) — it's about capping how much scrypt work
 * a scripted attempt loop can force the server to do per second. */
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60_000;
const LOCK_MS = 30_000;
interface Bucket {
  count: number;
  windowStart: number;
  lockedUntil: number;
}
const buckets = new Map<string, Bucket>();

export function loginGate(ip: string): { allowed: boolean; retryAfterSec?: number } {
  const b = buckets.get(ip);
  if (!b) return { allowed: true };
  const now = Date.now();
  if (b.lockedUntil > now) return { allowed: false, retryAfterSec: Math.ceil((b.lockedUntil - now) / 1000) };
  return { allowed: true };
}

export function recordLoginFailure(ip: string): void {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.windowStart > WINDOW_MS) b = { count: 0, windowStart: now, lockedUntil: 0 };
  b.count++;
  if (b.count >= MAX_ATTEMPTS) b.lockedUntil = now + LOCK_MS;
  buckets.set(ip, b);
}

export function recordLoginSuccess(ip: string): void {
  buckets.delete(ip);
}

/** test-only: forget every rate-limit bucket */
export function _resetLoginGateForTest(): void {
  buckets.clear();
}
