import type { AppState } from "@excontrol/shared";

/** "Everything", a group's label, or an EPS's label — what a schedule entry acts on. */
export function scheduleTargetLabel(state: Pick<AppState, "groups" | "devices">, target: string | undefined): string {
  const t = target || "all";
  if (t === "all") return "Everything";
  if (t.startsWith("group:")) return state.groups?.find((g) => g.id === t.slice(6))?.label ?? t.slice(6);
  return state.devices.find((d) => d.id === t)?.label ?? t;
}
