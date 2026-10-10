import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["web/src/**/*.ts"],
      reporter: ["text-summary", "text"],
    },
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "happy-dom",
          // Deterministic time formatting.
          env: { TZ: "UTC" },
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          globalSetup: ["tests/integration/setup/global.ts"],
          // One PocketBase process is shared; run files serially to keep rate limits and realtime predictable.
          fileParallelism: false,
          // Node 22 ships EventSource behind a flag; the PocketBase SDK needs it for realtime.
          execArgv: ["--experimental-eventsource", "--no-warnings=ExperimentalWarning"],
          testTimeout: 15_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
