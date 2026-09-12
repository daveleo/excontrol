import { describe, it, expect, afterEach } from "vitest";
import { startDevices, stopDevices } from "./registry.js";
import { store } from "./state.js";
import type { AppConfig } from "../config.js";

afterEach(async () => {
  await stopDevices();
});

const cfg = (): AppConfig => ({
  app: { name: "Test", httpPort: 8080, bind: "0.0.0.0", autoStart: true },
  devices: [
    { id: "eps-on", type: "expromo-eps", label: "Enabled EPS", enabled: true, host: "127.0.0.1", port: 1 },
    { id: "eps-off", type: "expromo-eps", label: "Disabled EPS", enabled: false, host: "127.0.0.1", port: 1 },
  ],
  presets: [],
  schedule: { entries: [] },
});

describe("startDevices — disabled devices are hidden, not just marked offline", () => {
  it("does not seed a card for a disabled device at all", async () => {
    await startDevices(cfg());
    const ids = store.all().map((d) => d.id);
    expect(ids).toContain("eps-on");
    expect(ids).not.toContain("eps-off");
  });
});
