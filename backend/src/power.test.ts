import { describe, it, expect, beforeAll, beforeEach, afterEach, vi, afterAll } from "vitest";
import type { DeviceState } from "@excontrol/shared";
import {
  computeEpsDomain, shouldFirePowerOn, startPowerMonitor, _resetRuntimeForTest, type DomainRuntime,
} from "./core/power.js";
import { store } from "./core/state.js";
import { bus } from "./core/bus.js";

const RT = (p: Partial<DomainRuntime> = {}): DomainRuntime => ({
  epsFirstOn: 0, prevLevel: "unknown", applyArmed: false, ...p,
});
const eps = (p: Partial<DeviceState> & { extra?: Record<string, unknown> } = {}): DeviceState => ({
  id: "eps", type: "expromo-eps", label: "Power", status: "online", zones: [], ...p,
});
const member = (p: Partial<DeviceState> = {}): DeviceState => ({
  id: "h", type: "novastar-h", label: "Wall", status: "online", poweredBy: "eps", zones: [], ...p,
});

describe("computeEpsDomain", () => {
  it("EPS unreachable → unknown", () => {
    const d = computeEpsDomain(eps({ status: "offline" }), [], RT());
    expect(d.level).toBe("unknown");
  });
  it("system OFF → off", () => {
    const d = computeEpsDomain(eps({ extra: { system: "OFF" } }), [member({ status: "powered-off" })], RT());
    expect(d.level).toBe("off");
    expect(d.headline).toMatch(/OFF/);
  });
  it("state SEQUENCING → starting", () => {
    const d = computeEpsDomain(eps({ extra: { system: "ON", state: "SEQUENCING" } }), [], RT());
    expect(d.level).toBe("starting");
  });
  it("ON with every member online → on", () => {
    const d = computeEpsDomain(eps({ extra: { system: "ON", state: "FULLY_ON", outputs: "111111" } }), [member()], RT());
    expect(d.level).toBe("on");
    expect(d.detail).toBeUndefined();
  });
  it("ON, a member still booting, within grace → starting (waiting on the controller)", () => {
    const d = computeEpsDomain(
      eps({ extra: { system: "ON", state: "FULLY_ON" } }),
      [member({ status: "initializing" })],
      RT({ epsFirstOn: Date.now() - 10_000 }),
    );
    expect(d.level).toBe("starting");
    expect(d.detail).toMatch(/waiting for/i);
  });
  it("ON, a member still down, past grace → on but flagged not responding", () => {
    const d = computeEpsDomain(
      eps({ extra: { system: "ON", state: "FULLY_ON" } }),
      [member({ status: "offline" })],
      RT({ epsFirstOn: Date.now() - 10 * 60_000 }),
    );
    expect(d.level).toBe("on");
    expect(d.detail).toMatch(/not responding/i);
  });
  it("ON with an output off → on, warns which output", () => {
    const d = computeEpsDomain(eps({ extra: { system: "ON", state: "FULLY_ON", outputs: "101111" } }), [], RT());
    expect(d.level).toBe("on");
    expect(d.detail).toMatch(/output 2 is OFF/i);
    expect(d.eps?.outputsOff).toEqual([2]);
  });
  it("members list includes the EPS id first", () => {
    const d = computeEpsDomain(eps({ extra: { system: "ON" } }), [member({ id: "h1" }), member({ id: "h2" })], RT());
    expect(d.members).toEqual(["eps", "h1", "h2"]);
  });
});

describe("shouldFirePowerOn", () => {
  const cases: Array<[Partial<DomainRuntime>, "on" | "off" | "starting" | "unknown", "on" | "off" | "starting" | "unknown", boolean]> = [
    [{ applyArmed: true }, "on", "off", true],
    [{ applyArmed: true }, "on", "starting", true],
    [{ applyArmed: true }, "on", "on", false],       // no transition
    [{ applyArmed: true }, "on", "unknown", false],  // startup next to an on wall
    [{ applyArmed: false }, "on", "off", false],     // never saw it off
    [{ applyArmed: true }, "starting", "off", false],
  ];
  it.each(cases)("armed=%o level=%s prev=%s → %s", (r, level, prev, want) => {
    expect(shouldFirePowerOn(RT(r), level, prev)).toBe(want);
  });
});

describe("power monitor — integration via the bus", () => {
  beforeAll(() => startPowerMonitor());
  beforeEach(() => _resetRuntimeForTest());
  afterEach(() => vi.useRealTimers());
  afterAll(() => vi.useRealTimers());

  const tick = () => Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
  const patch = async (p: Record<string, unknown> & { id: string }) => {
    bus.emit("device:patch", p as never);
    await tick();
  };

  it("a single EPS domain follows off → starting → on", async () => {
    store.init([
      { id: "eps", type: "expromo-eps", label: "P", status: "connecting", zones: [] },
      { id: "h", type: "novastar-h", label: "W", status: "connecting", poweredBy: "eps", zones: [] },
    ]);
    await patch({ id: "eps", status: "online", extra: { system: "OFF" } });
    expect(store.domainOf("h")?.level).toBe("off");

    await patch({ id: "eps", status: "online", extra: { system: "ON", state: "SEQUENCING" } });
    expect(store.domainOf("h")?.level).toBe("starting");

    await patch({ id: "eps", status: "online", extra: { system: "ON", state: "FULLY_ON" } });
    await patch({ id: "h", status: "online" });
    expect(store.domainOf("h")?.level).toBe("on");
  });

  it("H3: starting eXcontrol next to an already-on wall shows 'starting', not a fault", async () => {
    store.init([
      { id: "eps", type: "expromo-eps", label: "P", status: "connecting", zones: [] },
      { id: "h", type: "novastar-h", label: "W", status: "connecting", poweredBy: "eps", zones: [] },
    ]);
    // EPS already ON on first contact; controller still booting — never observed OFF.
    await patch({ id: "eps", status: "online", extra: { system: "ON", state: "FULLY_ON" } });
    const dom = store.domainOf("h")!;
    expect(dom.level).toBe("starting");
    expect(dom.detail).toMatch(/waiting for/i);

    // …and once the boot-grace window passes with the controller still down, it becomes a real fault.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 6 * 60_000);
    await patch({ id: "eps", status: "online", extra: { system: "ON", state: "FULLY_ON" } });
    expect(store.domainOf("h")?.level).toBe("on");
    expect(store.domainOf("h")?.detail).toMatch(/not responding/i);
    vi.useRealTimers();
  });

  it("two EPS units are independent power domains", async () => {
    store.init([
      { id: "eps1", type: "expromo-eps", label: "Stage", status: "connecting", zones: [] },
      { id: "eps2", type: "expromo-eps", label: "Lobby", status: "connecting", zones: [] },
      { id: "h1", type: "novastar-h", label: "Stage wall", status: "connecting", poweredBy: "eps1", zones: [] },
      { id: "h2", type: "novastar-h", label: "Lobby wall", status: "connecting", poweredBy: "eps2", zones: [] },
    ]);
    await patch({ id: "eps1", status: "online", extra: { system: "OFF" } });
    await patch({ id: "eps2", status: "online", extra: { system: "ON", state: "FULLY_ON" } });
    await patch({ id: "h2", status: "online" });

    expect(store.domainOf("h1")?.level).toBe("off");
    expect(store.domainOf("h2")?.level).toBe("on");
    expect(store.domainsList().map((d) => d.id).sort()).toEqual(["eps1", "eps2"]);
  });
});
