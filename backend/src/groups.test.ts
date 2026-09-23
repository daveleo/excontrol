import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import type { DeviceState, GroupConfig, PowerTarget } from "@excontrol/shared";
import {
  resolveTargets, planEpsOutputs, setGroupTarget, noteManual, startGroupEngine,
  _resetEngineForTest, _whenIdle, _engineTiming,
} from "./core/groups.js";
import { store } from "./core/state.js";
import { bus } from "./core/bus.js";
import { _setDriverForTest, _clearDriversForTest } from "./core/registry.js";
import { getConfig } from "./config.js";
import type { Driver } from "./drivers/types.js";

const dev = (id: string, type: DeviceState["type"], p: Partial<DeviceState> = {}): DeviceState => ({
  id, type, label: id, status: "online", zones: [], ...p,
});
const T = (o: Record<string, PowerTarget>) => new Map(Object.entries(o));
const g = (id: string, members: string[]): GroupConfig => ({ id, label: id, members });

describe("resolveTargets — who decides a device's state", () => {
  const devices = [
    dev("h9", "novastar-h", { poweredBy: "eps" }),
    dev("coex", "novastar-coex", { poweredBy: "eps" }),
    dev("exv", "exview", { poweredBy: "eps", poweredByOutput: 3 }),
    dev("exv2", "exview"),
    dev("obs", "obs"),
    dev("eps", "expromo-eps"),
  ];
  const groups = [g("wall", ["h9", "coex"]), g("screens", ["exv", "exv2"]), g("demo", ["coex", "exv2"])];

  it("a device in two groups follows the highest target (on > standby > off)", () => {
    const r = resolveTargets(devices, groups, T({ wall: "off", demo: "on", screens: "standby" }));
    expect(r.get("h9")?.target).toBe("off");
    expect(r.get("coex")).toMatchObject({ target: "on", via: ["demo"] });
    expect(r.get("exv")?.target).toBe("standby");
    expect(r.get("exv2")).toMatchObject({ target: "on", via: ["demo"] });
  });

  it("ties list every group that asked for it", () => {
    const r = resolveTargets(devices, groups, T({ wall: "on", demo: "on" }));
    expect(r.get("coex")?.via).toEqual(["wall", "demo"]);
  });

  it("a device in no group with a target follows Everything", () => {
    const r = resolveTargets(devices, [g("wall", ["h9"])], T({ all: "off" }));
    expect(r.get("coex")).toMatchObject({ target: "off", via: ["Everything"] });
  });

  it("a manual command on the device overrides its groups", () => {
    const r = resolveTargets(devices, groups, T({ screens: "off" }), new Map([["exv2", "on" as PowerTarget]]));
    expect(r.get("exv2")).toMatchObject({ target: "on", manual: true });
  });

  it("EPS units and OBS aren't controllable members", () => {
    const r = resolveTargets(devices, groups, T({ all: "off" }));
    expect(r.has("eps")).toBe(false);
    expect(r.has("obs")).toBe(false);
  });
});

describe("planEpsOutputs — which relays go where", () => {
  const members = [
    dev("h9", "novastar-h", { poweredBy: "eps" }),
    dev("coex", "novastar-coex", { poweredBy: "eps" }),
    dev("exv", "exview", { poweredBy: "eps", poweredByOutput: 3 }),
  ];
  const t = (o: Record<string, PowerTarget | undefined>) => (id: string) => o[id];

  it("a device on its own output owns just that relay; whole-unit devices share the rest", () => {
    const p = planEpsOutputs(members, t({ h9: "on", coex: "on", exv: "off" }));
    expect(p.desired).toEqual([true, true, false, true, true, true]);
  });

  it("the shared relays go off only when every whole-unit device is off", () => {
    expect(planEpsOutputs(members, t({ h9: "off", coex: "off", exv: "on" })).desired)
      .toEqual([false, false, true, false, false, false]);
  });

  it("an Off device whose relays someone else still needs is held on — and the plan says by whom", () => {
    const p = planEpsOutputs(members, t({ h9: "off", coex: "on" }));
    expect(p.desired[0]).toBe(true);
    expect(p.heldOn.get("h9")).toEqual(["coex"]);
  });

  it("standby keeps power on", () => {
    expect(planEpsOutputs(members, t({ exv: "standby" })).desired[2]).toBe(true);
  });

  it("no target → leave alone", () => {
    expect(planEpsOutputs(members, t({})).desired).toEqual(Array(6).fill(undefined));
  });

  it("protected relays are never planned off", () => {
    const p = planEpsOutputs(members, t({ h9: "off", coex: "off" }), new Set([5]));
    expect(p.desired[4]).toBeUndefined();
    expect(p.desired[0]).toBe(false);
  });
});

/* ---- end to end: the engine driving fake drivers ---- */

interface Call { dev: string; what: string; at: number }
let calls: Call[] = [];

function fakeEps(id: string, bits: string): Driver {
  let b = bits.split("");
  return {
    id, type: "expromo-eps", start: async () => {}, stop: async () => {}, zones: () => [],
    applyOutputs: async (desired) => {
      calls.push({ dev: id, what: `outputs ${desired.map((v) => (v === undefined ? "-" : v ? "1" : "0")).join("")}`, at: Date.now() });
      b = b.map((c, i) => (desired[i] === undefined ? c : desired[i] ? "1" : "0"));
      bus.emit("device:patch", { id, extra: { system: b.includes("1") ? "ON" : "OFF", state: "FULLY_ON", outputs: b.join("") } });
      await new Promise((r) => setTimeout(r, 5));
    },
  };
}
function fakeExview(id: string): Driver {
  return {
    id, type: "exview", start: async () => {}, stop: async () => {}, zones: () => [{ id: "screen", label: "Screen" }],
    setPowerState: async (_z, state) => {
      calls.push({ dev: id, what: `power ${state}`, at: Date.now() });
      bus.emit("device:patch", { id, zones: [{ id: "screen", label: "Screen", on: state === "on", powerState: state }] });
    },
  };
}
function fakeNova(id: string): Driver {
  return {
    id, type: "novastar-h", start: async () => {}, stop: async () => {}, zones: () => [{ id: "s0", label: "S" }],
    setBlackout: async (_z, on) => {
      calls.push({ dev: id, what: `blackout ${on}`, at: Date.now() });
      bus.emit("device:patch", { id, zones: [{ id: "s0", label: "S", blackout: on }] });
    },
  };
}

describe("power engine, end to end", () => {
  beforeAll(() => {
    Object.assign(_engineTiming, { unitGapMs: 30, wakeStaggerMs: 10, bootWaitMs: 500, pollMs: 10 });
    startGroupEngine();
  });
  beforeEach(() => {
    calls = [];
    _resetEngineForTest();
    _clearDriversForTest();
    const cfg = getConfig();
    cfg.devices = [
      { id: "eps", type: "expromo-eps", label: "EPS", enabled: true, host: "x", port: 1 },
      { id: "eps2", type: "expromo-eps", label: "EPS 2", enabled: true, host: "x", port: 1 },
      { id: "h9", type: "novastar-h", label: "H9", enabled: true, host: "x", port: 1, poweredBy: "eps", pId: "", secretKey: "", zones: [] },
      { id: "exv", type: "exview", label: "eXview on EPS", enabled: true, host: "x", port: 1, poweredBy: "eps", poweredByOutput: 3, model: "edge" },
      { id: "exv2", type: "exview", label: "eXview socket", enabled: true, host: "x", port: 1, model: "edge" },
      { id: "cab", type: "novastar-h", label: "Test load", enabled: true, host: "x", port: 1, poweredBy: "eps2", pId: "", secretKey: "", zones: [] },
    ];
    cfg.groups = [g("wall", ["h9", "cab"]), g("screens", ["exv", "exv2"]), g("demo", ["exv2"])];
    store.init([
      dev("eps", "expromo-eps", { extra: { system: "ON", outputs: "111111" } }),
      dev("eps2", "expromo-eps", { extra: { system: "OFF", outputs: "000000" } }),
      dev("h9", "novastar-h", { poweredBy: "eps", zones: [{ id: "s0", label: "S", blackout: false }] }),
      dev("exv", "exview", { poweredBy: "eps", poweredByOutput: 3, zones: [{ id: "screen", label: "Screen", powerState: "on", on: true }] }),
      dev("exv2", "exview", { zones: [{ id: "screen", label: "Screen", powerState: "on", on: true }] }),
      dev("cab", "novastar-h", { poweredBy: "eps2", status: "powered-off", zones: [{ id: "s0", label: "S" }] }),
    ]);
    for (const d of [fakeEps("eps", "111111"), fakeEps("eps2", "000000"), fakeNova("h9"), fakeNova("cab"), fakeExview("exv"), fakeExview("exv2")]) {
      _setDriverForTest(d);
    }
  });
  afterEach(() => { getConfig().groups = []; getConfig().devices = []; });

  it("Screens → Off: the EPS-fed eXview's output is cut (EPS decides), the socket eXview goes to standby", async () => {
    await setGroupTarget("screens", "off", "test");
    await _whenIdle();
    expect(calls.map((c) => `${c.dev} ${c.what}`)).toEqual([
      "exv2 power standby",
      "eps outputs --0---",
    ]);
  });

  it("highest wins: Screens → Off while Demo is On keeps the socket eXview on", async () => {
    await setGroupTarget("demo", "on", "test");
    await setGroupTarget("screens", "off", "test");
    await _whenIdle();
    expect(calls.map((c) => `${c.dev} ${c.what}`)).toEqual(["eps outputs --0---"]);
    const t = store.snapshot().deviceTargets.find((x) => x.deviceId === "exv2");
    expect(t).toMatchObject({ target: "on", via: ["demo"] });
  });

  it("Everything → Off: soft-offs first, then units off in reverse order", async () => {
    await setGroupTarget("all", "off", "test");
    await _whenIdle();
    const seq = calls.map((c) => `${c.dev} ${c.what}`);
    expect(seq[0]).toBe("exv2 power standby");
    expect(seq).toContain("eps outputs 000000");
    expect(seq.indexOf("exv2 power standby")).toBeLessThan(seq.indexOf("eps outputs 000000"));
  });

  it("Everything → On: units are chained with a gap (one inrush at a time), then screens woken", async () => {
    store.init([
      ...store.all().map((d) => (d.id === "eps" ? { ...d, extra: { system: "OFF", outputs: "000000" } } : d)),
    ]);
    _setDriverForTest(fakeEps("eps", "000000"));
    await setGroupTarget("all", "on", "test");
    // the devices come online as their power arrives
    bus.emit("device:patch", { id: "cab", status: "online" });
    await _whenIdle();
    const epsCalls = calls.filter((c) => c.dev.startsWith("eps"));
    expect(epsCalls.map((c) => c.dev)).toEqual(["eps", "eps2"]);
    expect(epsCalls[1]!.at - epsCalls[0]!.at).toBeGreaterThanOrEqual(25);
  });

  it("a device switched back on after Off is reported — once — as an alert", async () => {
    await setGroupTarget("screens", "standby", "Schedule: Night");
    await _whenIdle();
    expect(store.alertsList()).toHaveLength(0);
    bus.emit("device:patch", { id: "exv2", zones: [{ id: "screen", label: "Screen", on: true, powerState: "on" }] });
    await new Promise((r) => setTimeout(r, 5));
    expect(store.alertsList()).toHaveLength(1);
    expect(store.alertsList()[0]!.text).toMatch(/exv2 turned On after it was set to Standby \(Schedule: Night/);
  });

  it("…but not when the operator did it on the device's own card", async () => {
    await setGroupTarget("screens", "standby", "test");
    await _whenIdle();
    noteManual("exv2", "on");
    bus.emit("device:patch", { id: "exv2", zones: [{ id: "screen", label: "Screen", on: true, powerState: "on" }] });
    await new Promise((r) => setTimeout(r, 5));
    expect(store.alertsList().map((a) => a.text)).toEqual([]);
  });
});
