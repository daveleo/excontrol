import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
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

function hash(password: string, saltHex: string): string {
  return scryptSync(password, Buffer.from(saltHex, "hex"), 32).toString("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function checkPassword(password: string): boolean {
  const cfg = getConfig();
  const { settingsPasswordHash, settingsPasswordSalt } = cfg.app;
  if (!settingsPasswordHash || !settingsPasswordSalt) return false;
  if (typeof password !== "string" || !password) return false;
  try {
    return safeEqualHex(hash(password, settingsPasswordSalt), settingsPasswordHash);
  } catch {
    return false;
  }
}

/** Set, change or remove the settings password. Throws if `currentPassword` doesn't match
 *  an existing one (removing/changing always requires it; setting the first one doesn't). */
export function setPassword(newPassword: string | null | undefined, currentPassword?: string): void {
  const cfg = getConfig();
  if (isSettingsLocked() && !checkPassword(currentPassword ?? "")) {
    throw new Error("current password is incorrect");
  }
  if (!newPassword) {
    saveConfig({ ...cfg, app: { ...cfg.app, settingsPasswordHash: undefined, settingsPasswordSalt: undefined } });
    tokens.clear();
    log.info({}, "settings password removed");
    return;
  }
  const salt = randomBytes(16).toString("hex");
  saveConfig({ ...cfg, app: { ...cfg.app, settingsPasswordSalt: salt, settingsPasswordHash: hash(newPassword, salt) } });
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
