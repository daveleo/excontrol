import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import type { SetBrightnessBody, RecallPresetBody, SetBlackoutBody, AppPreset, ScheduleEntry } from "@excontrol/shared";
import { store } from "../core/state.js";
import { getDriver } from "../core/registry.js";
import { bus } from "../core/bus.js";
import { getPresets, savePreset, deletePreset, applyPreset } from "../core/presets.js";
import { getSchedule, setEntries, snooze } from "../core/schedule.js";
import { powerDomain } from "../core/power.js";
import { log } from "../logger.js";

const here = dirname(fileURLToPath(import.meta.url));

export async function buildHttp() {
  const app = Fastify({ logger: false });
  // In the Electron build the front-end is packaged elsewhere; the main process points here.
  const frontendDist = process.env.EXCONTROL_FRONTEND_DIR
    ? resolve(process.env.EXCONTROL_FRONTEND_DIR)
    : resolve(here, "../../../frontend/dist");

  const fail = (reply: any, code: number, e: unknown) =>
    reply.code(code).send({ error: String(e instanceof Error ? e.message : e) });

  app.get("/health", async () => ({
    ok: true,
    version: store.appInfo().version,
    configured: store.appInfo().configured,
    devices: store.all().map((d) => ({ id: d.id, status: d.status })),
  }));

  app.get("/api/state", async () => store.snapshot());

  /* ---- zone-scoped device control ---- */

  async function zoneOp(
    reply: any,
    id: string,
    zoneId: string,
    cap: "setBrightness" | "recallPreset" | "setBlackout",
    arg: number | boolean,
  ) {
    const drv = getDriver(id);
    const fn = drv?.[cap];
    if (!drv || !fn) return reply.code(400).send({ error: `device has no ${cap}` });
    const zone = zoneId === "-" ? drv.zones()[0]?.id : zoneId;
    if (!zone) return reply.code(400).send({ error: "no such zone" });
    try {
      await (fn as (z: string, a: number | boolean) => Promise<void>).call(drv, zone, arg);
      return { ok: true };
    } catch (e) {
      log.error({ id, zone, cap, err: e }, "zone op failed");
      return fail(reply, 502, e);
    }
  }

  app.post<{ Params: { id: string; zoneId: string }; Body: SetBrightnessBody }>(
    "/api/devices/:id/zones/:zoneId/brightness",
    (req, reply) => {
      const pct = Number(req.body?.brightness);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) return reply.code(400).send({ error: "brightness must be 0..100" });
      return zoneOp(reply, req.params.id, req.params.zoneId, "setBrightness", pct);
    },
  );
  app.post<{ Params: { id: string; zoneId: string }; Body: RecallPresetBody }>(
    "/api/devices/:id/zones/:zoneId/preset",
    (req, reply) => {
      const p = Number(req.body?.presetId);
      if (!Number.isInteger(p)) return reply.code(400).send({ error: "presetId must be an integer" });
      return zoneOp(reply, req.params.id, req.params.zoneId, "recallPreset", p);
    },
  );
  app.post<{ Params: { id: string; zoneId: string }; Body: SetBlackoutBody }>(
    "/api/devices/:id/zones/:zoneId/blackout",
    (req, reply) => zoneOp(reply, req.params.id, req.params.zoneId, "setBlackout", Boolean(req.body?.blackout)),
  );

  app.post<{ Params: { id: string; name: string } }>("/api/devices/:id/action/:name", async (req, reply) => {
    const drv = getDriver(req.params.id);
    if (!drv?.action) return reply.code(400).send({ error: "device has no actions" });
    try {
      return { ok: true, result: await drv.action(req.params.name) };
    } catch (e) {
      return fail(reply, 502, e);
    }
  });

  /* ---- power ---- */

  app.post<{ Params: { target: string; onoff: "on" | "off" } }>("/api/power/:target/:onoff", async (req, reply) => {
    try {
      await powerDomain(req.params.target, req.params.onoff === "on");
      return { ok: true };
    } catch (e) {
      return fail(reply, 502, e);
    }
  });

  /* ---- presets ---- */

  app.get("/api/presets", async () => getPresets());
  app.post<{ Body: Partial<AppPreset> & { label: string } }>("/api/presets", async (req, reply) => {
    if (!req.body?.label) return reply.code(400).send({ error: "label required" });
    return savePreset(req.body);
  });
  app.delete<{ Params: { id: string } }>("/api/presets/:id", async (req) => {
    deletePreset(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>("/api/presets/:id/apply", async (req, reply) => {
    try {
      await applyPreset(req.params.id, { manual: true });
      return { ok: true };
    } catch (e) {
      return fail(reply, 502, e);
    }
  });

  /* ---- schedule ---- */

  app.get("/api/schedule", async () => getSchedule());
  app.put<{ Body: { entries: ScheduleEntry[] } }>("/api/schedule", async (req, reply) => {
    if (!Array.isArray(req.body?.entries)) return reply.code(400).send({ error: "entries[] required" });
    return setEntries(req.body.entries);
  });
  app.post<{ Body: { hours?: number; clear?: boolean } }>("/api/schedule/snooze", async (req) => {
    const { hours = 1, clear = false } = req.body ?? {};
    return snooze(Number(hours), Boolean(clear));
  });

  /* ---- misc ---- */

  app.post<{ Body: { paused: boolean } }>("/api/updates/pause", async (req) => {
    store.updatesPaused = Boolean(req.body?.paused);
    bus.emit("broadcast", { t: "snapshot", state: store.snapshot() });
    return { ok: true, paused: store.updatesPaused };
  });

  app.post("/api/internal/reload", async (req, reply) => {
    const ip = req.ip;
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") {
      return reply.code(403).send({ error: "localhost only" });
    }
    bus.emit("broadcast", { t: "reload", reason: "redeploy" });
    return { ok: true };
  });

  /* ---- static front-end ---- */

  if (existsSync(frontendDist)) {
    await app.register(fastifyStatic, { root: frontendDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith("/api")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  } else {
    log.warn({ frontendDist }, "frontend/dist not found — run `npm run build`");
  }

  return app;
}
