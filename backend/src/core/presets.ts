import { randomUUID } from "node:crypto";
import type { AppPreset, PresetAction } from "@excontrol/shared";
import { getConfig, saveConfig } from "../config.js";
import { getDriver } from "./registry.js";
import { bus, toast } from "./bus.js";
import { ObsDriver } from "../drivers/obs.js";
import { log } from "../logger.js";

export function getPresets(): AppPreset[] {
  return getConfig().presets;
}

export function savePreset(p: Partial<AppPreset> & { label: string }): AppPreset {
  const cfg = getConfig();
  const clean: AppPreset = {
    id: p.id || randomUUID(),
    label: String(p.label).slice(0, 60) || "Preset",
    actions: Array.isArray(p.actions) ? p.actions.filter((a) => a && typeof a.target === "string") : [],
    powerOnDefaultFor: p.powerOnDefaultFor ?? null,
  };
  const idx = cfg.presets.findIndex((x) => x.id === clean.id);
  const presets = [...cfg.presets];
  if (idx >= 0) presets[idx] = clean;
  else presets.push(clean);
  saveConfig({ ...cfg, presets });
  bus.emit("broadcast", { t: "presets", presets });
  return clean;
}

export function deletePreset(id: string): void {
  const cfg = getConfig();
  const presets = cfg.presets.filter((p) => p.id !== id);
  saveConfig({ ...cfg, presets });
  bus.emit("broadcast", { t: "presets", presets });
}

/** [deviceId, zoneId?] from "dev" or "dev:zone" */
function splitTarget(target: string): [string, string | undefined] {
  const i = target.indexOf(":");
  return i < 0 ? [target, undefined] : [target.slice(0, i), target.slice(i + 1)];
}

async function runAction(a: PresetAction): Promise<void> {
  const [deviceId, zoneRef] = splitTarget(a.target);
  const drv = getDriver(deviceId);
  if (!drv) throw new Error(`unknown device "${deviceId}"`);

  if (a.power && drv.action) {
    await drv.action(a.power === "on" ? "power_on" : "power_off");
    return;
  }
  if (a.scene != null && drv instanceof ObsDriver) {
    const id = drv.sceneId(a.scene);
    if (id == null) throw new Error(`OBS: scene "${a.scene}" not found`);
    await drv.recallPreset("scenes", id);
    return;
  }

  const zoneId = zoneRef ?? drv.zones()[0]?.id;
  if (!zoneId) throw new Error(`${deviceId}: no zone to act on`);
  if (typeof a.brightness === "number" && drv.setBrightness) await drv.setBrightness(zoneId, a.brightness);
  if (typeof a.preset === "number" && drv.recallPreset) await drv.recallPreset(zoneId, a.preset);
  if (typeof a.blackout === "boolean" && drv.setBlackout) await drv.setBlackout(zoneId, a.blackout);
}

/** Apply a preset. `only` limits it to actions whose device is in that set (power-on scope). */
export async function applyPreset(id: string, opts: { manual?: boolean; only?: Set<string> } = {}): Promise<void> {
  const preset = getPresets().find((p) => p.id === id);
  if (!preset) {
    if (opts.manual) throw new Error(`no preset "${id}"`);
    return;
  }
  const actions = opts.only
    ? preset.actions.filter((a) => opts.only!.has(splitTarget(a.target)[0]))
    : preset.actions;
  log.info({ preset: preset.label, count: actions.length, manual: opts.manual }, "applying preset");

  const results = await Promise.allSettled(actions.map(runAction));
  const failed = results.filter((r) => r.status === "rejected").length;
  toast(failed ? "warn" : "info", failed ? `"${preset.label}": ${failed} action(s) failed` : `"${preset.label}" applied`);
}
