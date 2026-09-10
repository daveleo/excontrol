import type { ProbeResult, SetupDevice } from "@excontrol/shared";
import type { CoexConfig, EpsConfig, HConfig, ObsConfig } from "../config.js";
import { NovastarHDriver } from "../drivers/novastar-h.js";
import { NovastarCoexDriver } from "../drivers/novastar-mx40.js";
import { EpsDriver } from "../drivers/eps.js";
import { ObsDriver } from "../drivers/obs.js";
import { resolveSecrets } from "../config.js";

const DEFAULT_PORT: Record<SetupDevice["type"], number> = {
  "novastar-h": 8000,
  "novastar-coex": 8001,
  "expromo-eps": 5000,
  obs: 4455,
};

/** Test one device as the wizard has it on screen (kept-secret sentinels resolved). */
export async function probeDevice(input: SetupDevice): Promise<ProbeResult> {
  const d = resolveSecrets(input);
  const host = (d.host || "").trim();
  const port = Number(d.port) || DEFAULT_PORT[d.type];
  if (!host) return { ok: false, hint: "misconfigured", detail: "Enter the device's IP address first." };

  const base = { id: d.id || "probe", label: d.label || "probe", enabled: true, host, port, pollMs: 4000 } as const;

  try {
    switch (d.type) {
      case "novastar-h":
        if (!d.pId || !d.secretKey)
          return { ok: false, hint: "misconfigured", detail: "Enter the OpenAPI Project ID and Secret Key." };
        return await NovastarHDriver.probe({
          ...base, type: "novastar-h", pId: d.pId, secretKey: d.secretKey, encrypted: !!d.encrypted, zones: [],
        } satisfies HConfig);
      case "novastar-coex":
        return await NovastarCoexDriver.probe({ ...base, type: "novastar-coex", zones: [] } satisfies CoexConfig);
      case "expromo-eps":
        return await EpsDriver.probe({ ...base, type: "expromo-eps" } satisfies EpsConfig);
      case "obs":
        return await ObsDriver.probe({ ...base, type: "obs", password: d.password ?? "" } satisfies ObsConfig);
    }
  } catch (e) {
    return { ok: false, hint: "bad-response", detail: e instanceof Error ? e.message : String(e) };
  }
}
