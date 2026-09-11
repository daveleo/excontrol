import { build } from "esbuild";

/**
 * Bundle the Electron main + the whole backend into one file. All backend deps are pure
 * JS (fastify, ws, crypto-js, obs-websocket-js, @fastify/static) so this is clean — none
 * of them need to ship as real node_modules.
 *
 * `electron-updater` is the one exception: it dynamically requires platform-specific
 * updater code and ships a native helper (7zip-bin, for NSIS differential downloads), so
 * it can't be flattened into the bundle like the others. It's left external and shipped
 * as a real dependency instead — see desktop/package.json's `files`.
 */
await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "out/main.mjs",
  external: ["electron", "electron-updater"],
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
