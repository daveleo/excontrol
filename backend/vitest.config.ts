import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    // Windows + parallel workers intermittently hit EBUSY on vitest's transform cache.
    // The suite runs in ~1s; serialise the files and the flake goes away.
    fileParallelism: false,
  },
});
