import type { TestProject } from "vitest/node";
import { disableRateLimits, startPocketBase } from "./pocketbase.ts";

declare module "vitest" {
  export interface ProvidedContext {
    pbUrl: string;
    pbDataDir: string;
    pbPublicDir: string;
    /** Rate limit settings exactly as the migrations left them, before the harness disabled them. */
    bootRateLimits: { enabled: boolean; rules: { label: string; audience: string; duration: number; maxRequests: number }[] };
  }
}

export default async function setup(project: TestProject) {
  const pb = await startPocketBase({ verbose: process.env.PB_VERBOSE === "1" });

  // Record the migrated settings, then disable limits; http.test.ts re-enables them for its own test.
  const bootRateLimits = await disableRateLimits(pb.url);

  project.provide("pbUrl", pb.url);
  project.provide("pbDataDir", pb.dataDir);
  project.provide("pbPublicDir", pb.publicDir);
  project.provide("bootRateLimits", bootRateLimits);
  return () => pb.stop();
}
