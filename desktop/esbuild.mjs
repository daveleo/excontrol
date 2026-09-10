import { build } from "esbuild";

/**
 * Bundle the Electron main + the whole backend into one CJS file. All backend deps are
 * pure JS (fastify, ws, crypto-js, obs-websocket-js, @fastify/static) so this is clean —
 * the packaged app carries no node_modules.
 */
await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "out/main.mjs",
  external: ["electron"],
  sourcemap: true,
  logLevel: "info",
  // esm output + node: keep require/import.meta working for any CJS deps pulled in
  banner: {
    js: [
      "/* eXcontrol desktop - bundled main process */",
      "import { createRequire as ___cr } from 'node:module';",
      "const require = ___cr(import.meta.url);",
    ].join("\n"),
  },
});

console.log("bundled -> out/main.mjs");
