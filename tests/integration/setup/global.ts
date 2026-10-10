import PocketBase from "pocketbase";
import type { TestProject } from "vitest/node";
import { SUPERUSER, startPocketBase } from "./pocketbase.ts";

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

  // Every test hits PocketBase from 127.0.0.1, so per-IP rate limits would trip across unrelated tests.
  // Record the migrated settings, then disable limits; http.test.ts re-enables them for its own test.
  const admin = new PocketBase(pb.url);
  await admin.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
  const settings = await admin.settings.getAll();
  await admin.settings.update({ rateLimits: { ...settings.rateLimits, enabled: false } });

  project.provide("pbUrl", pb.url);
  project.provide("pbDataDir", pb.dataDir);
  project.provide("pbPublicDir", pb.publicDir);
  project.provide("bootRateLimits", settings.rateLimits);
  return () => pb.stop();
}
