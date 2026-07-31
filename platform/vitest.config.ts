import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/globalSetup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Integration tests share one database; keep files sequential there.
    fileParallelism: false,
  },
});
