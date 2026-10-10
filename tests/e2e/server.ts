// Playwright webServer: serves the built pb_public/ from a fresh PocketBase with a temp data dir.
import { resolve } from "node:path";
import { startPocketBase } from "../support/pocketbase.ts";

const pb = await startPocketBase({
  publicDir: resolve("pb_public"),
  port: Number(process.env.E2E_PORT ?? 8091),
  verbose: process.env.PB_VERBOSE === "1",
});
console.log(`e2e pocketbase listening at ${pb.url}`);

const stop = async () => {
  await pb.stop();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
