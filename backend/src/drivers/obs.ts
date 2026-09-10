import OBSWebSocket from "obs-websocket-js";
import { BaseDriver } from "./types.js";
import type { ObsConfig } from "../config.js";
import type { Preset } from "@excontrol/shared";

const ZONE = "scenes";

/**
 * OBS Studio via obs-websocket v5. Exposes one zone ("scenes") whose presets are the
 * OBS scenes; recalling a preset switches the program scene. Stays in sync with changes
 * made directly in OBS.
 */
export class ObsDriver extends BaseDriver {
  private readonly c: ObsConfig;
  private obs = new OBSWebSocket();
  private connected = false;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(cfg: ObsConfig) {
    super(cfg);
    this.c = cfg;
    this.zoneState = [{ id: ZONE, label: "Scene" }];
  }

  async start(): Promise<void> {
    this.patch({ zones: this.zoneState });
    this.obs.on("ConnectionClosed", () => {
      this.connected = false;
      this.patch({ status: "offline", error: "connection closed" });
      this.scheduleReconnect();
    });
    this.obs.on("CurrentProgramSceneChanged", () => void this.refreshScenes());
    this.obs.on("SceneListChanged", () => void this.refreshScenes());
    await this.connect();
  }

  override async stop(): Promise<void> {
    await super.stop();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.connected) await this.obs.disconnect();
  }

  async recallPreset(zoneId: string, presetId: number): Promise<void> {
    if (zoneId !== ZONE) throw new Error(`${this.id}: no zone "${zoneId}"`);
    const scenes = await this.listScenes();
    const scene = scenes.find((s) => s.id === presetId);
    if (!scene) throw new Error(`OBS: no scene #${presetId}`);
    await this.obs.call("SetCurrentProgramScene", { sceneName: scene.name });
    this.patchZone(ZONE, { activePreset: presetId });
    this.patch({ extra: { programScene: scene.name }, lastSeen: Date.now() });
  }

  /** Resolve a scene name → its zone preset id (for preset actions). */
  sceneId(name: string): number | undefined {
    return this.zoneState[0]?.presets?.find((p) => p.name === name)?.id;
  }

  private async connect(): Promise<void> {
    this.patch({ status: "connecting" });
    try {
      await this.obs.connect(`ws://${this.c.host}:${this.c.port}`, this.c.password);
      this.connected = true;
      this.online();
      await this.refreshScenes();
    } catch (e) {
      this.offline(e);
      this.scheduleReconnect();
    }
  }

  private async refreshScenes(): Promise<void> {
    if (!this.connected) return;
    try {
      const scenes = await this.listScenes();
      const { currentProgramSceneName } = await this.obs.call("GetCurrentProgramScene");
      this.patchZone(ZONE, {
        presets: scenes,
        activePreset: scenes.find((s) => s.name === currentProgramSceneName)?.id,
      });
      this.patch({ status: "online", extra: { programScene: currentProgramSceneName }, lastSeen: Date.now() });
    } catch {
      /* transient — the next event or reconnect re-syncs */
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, this.c.pollMs ?? 5000);
  }

  private async listScenes(): Promise<Preset[]> {
    const { scenes } = await this.obs.call("GetSceneList");
    return [...scenes].reverse().map((s, i) => ({ id: i, name: String(s.sceneName) }));
  }
}
