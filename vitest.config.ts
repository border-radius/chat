import { defineConfig } from "vitest/config";

// Both projects run against a real, throwaway PocketBase (temp data dir) started by tests/support/global-setup.ts.
const globalSetup = ["tests/support/global-setup.ts"];

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["web/src/**/*.ts"],
      reporter: ["text-summary", "text"],
    },
    projects: [
      {
        // What the build defines (scripts/lib/build-utils.mjs).
        define: { VIEWER_CSS: JSON.stringify("/assets/viewer.css"), MEDIA_CSS: JSON.stringify("/assets/media.css") },
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "happy-dom",
          globalSetup,
          // Node's built-in EventSource doesn't work under happy-dom; install a fetch-based one for the SDK.
          setupFiles: ["tests/support/eventsource.ts", "tests/support/cleanup.ts"],
          // Deterministic time formatting.
          env: { TZ: "UTC" },
          testTimeout: 15_000,
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          globalSetup,
          // Run files serially so rate-limit and realtime tests don't interfere with each other.
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
