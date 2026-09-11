/**
 * Lets a request handler (the setup-save route) trigger an HTTP-layer restart after an
 * `app.httpPort` / `app.bind` change, without http.ts needing a reference to the
 * `RunningServer` object that index.ts owns.
 */
type Restarter = () => Promise<{ url: string; port: number }>;

let restarter: Restarter | null = null;

export function registerHttpRestarter(fn: Restarter | null): void {
  restarter = fn;
}

export async function restartHttpServer(): Promise<{ url: string; port: number }> {
  if (!restarter) throw new Error("HTTP restart is not available in this runtime");
  return restarter();
}
