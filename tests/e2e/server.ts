// Playwright webServer: serves the built pb_public/ from a fresh PocketBase.
// The data dir is predictable (see fixtures.ts) so specs can seed large histories straight into SQLite.
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { disableRateLimits, startPocketBase } from "../support/pocketbase.ts";
import { E2E_DATA_DIR, E2E_PORT } from "./paths.ts";

await rm(E2E_DATA_DIR, { recursive: true, force: true });
const pb = await startPocketBase({
  publicDir: resolve("pb_public"),
  port: E2E_PORT,
  dataDir: E2E_DATA_DIR,
  verbose: process.env.PB_VERBOSE === "1",
});

await disableRateLimits(pb.url); // all e2e users sign up from 127.0.0.1

console.log(`e2e pocketbase listening at ${pb.url}`);

const stop = async () => {
  await pb.stop();
  await rm(E2E_DATA_DIR, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
