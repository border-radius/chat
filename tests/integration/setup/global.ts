import type { TestProject } from "vitest/node";
import { startPocketBase } from "./pocketbase.ts";

declare module "vitest" {
  export interface ProvidedContext {
    pbUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const pb = await startPocketBase({ verbose: process.env.PB_VERBOSE === "1" });
  project.provide("pbUrl", pb.url);
  return () => pb.stop();
}
