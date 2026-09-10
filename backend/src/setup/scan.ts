import { Socket } from "node:net";
import { networkInterfaces } from "node:os";
import type { DeviceType, ScanHit } from "@excontrol/shared";

/** ports we knock on, and the device type each one suggests */
const PORTS: Array<{ port: number; guess: DeviceType }> = [
  { port: 8000, guess: "novastar-h" },
  { port: 8001, guess: "novastar-coex" },
  { port: 5000, guess: "expromo-eps" },
  { port: 4455, guess: "obs" },
];

function tcpOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    sock.connect(port, host);
  });
}

/** IPv4 /24 subnets this machine is on (deduped), excluding loopback and link-local. */
export function localSubnets(): string[] {
  const nets = new Set<string>();
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family !== "IPv4" || i.internal || !i.address) continue;
      if (i.address.startsWith("169.254.")) continue; // APIPA / link-local — nothing routable there
      nets.add(i.address.split(".").slice(0, 3).join("."));
    }
  }
  return [...nets];
}

/**
 * Knock on every host in this machine's /24(s) for the known control ports.
 * Explicit, operator-triggered — not something that runs on its own.
 */
export async function scanSubnets(timeoutMs = 350, concurrency = 256): Promise<ScanHit[]> {
  const jobs: Array<() => Promise<ScanHit | null>> = [];
  for (const net of localSubnets()) {
    for (let h = 1; h <= 254; h++) {
      const host = `${net}.${h}`;
      for (const { port, guess } of PORTS) {
        jobs.push(async () => ((await tcpOpen(host, port, timeoutMs)) ? { host, port, guess } : null));
      }
    }
  }

  const hits: ScanHit[] = [];
  let idx = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    for (let job = jobs[idx++]; job; job = jobs[idx++]) {
      const hit = await job();
      if (hit) hits.push(hit);
    }
  });
  await Promise.all(workers);
  hits.sort((a, b) => (a.host === b.host ? a.port - b.port : cmpIp(a.host, b.host)));
  return hits;
}

function cmpIp(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 4; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
