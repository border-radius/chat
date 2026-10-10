import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "happy-dom",
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
