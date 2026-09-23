import type { AppState, ScheduleEntry } from "@excontrol/shared";
import { roomLabel } from "@excontrol/shared";

type Ctx = Pick<AppState, "groups" | "devices"> & { app?: AppState["app"] };

/** The room's name, a group's label, or an EPS's label — what a schedule entry acts on. */
export function scheduleTargetLabel(state: Ctx, target: string | undefined): string {
  const t = target || "all";
  if (t === "all") return state.groups?.find((g) => g.id === "all")?.label ?? roomLabel(state.app?.name);
  if (t.startsWith("group:")) return state.groups?.find((g) => g.id === t.slice(6))?.label ?? t.slice(6);
  return state.devices.find((d) => d.id === t)?.label ?? t;
}

const VERB: Record<ScheduleEntry["action"], string> = {
  power_on: "Turn on", power_off: "Turn off", standby: "Standby", apply_preset: "Apply scene",
};

/** "Turn off Showroom" / "Apply scene Evening" — also the entry's automatic label. */
export function describeEntry(state: Ctx & Pick<AppState, "presets">, e: ScheduleEntry): string {
  if (e.action === "apply_preset") {
    return `${VERB.apply_preset} ${state.presets.find((p) => p.id === e.presetId)?.label ?? "—"}`;
  }
  return `${VERB[e.action]} ${scheduleTargetLabel(state, e.target)}`;
}
