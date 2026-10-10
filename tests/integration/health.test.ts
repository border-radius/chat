import { describe, expect, inject, it } from "vitest";
import { adminClient, newUser } from "./helpers.ts";

describe("integration harness", () => {
  it("serves /api/health", async () => {
    const res = await fetch(`${inject("pbUrl")}/api/health`);
    expect(res.status).toBe(200);
  });

  it("authenticates the superuser", async () => {
    const pb = await adminClient();
    expect(pb.authStore.isSuperuser).toBe(true);
  });

  it("creates distinct, authenticated users", async () => {
    const a = await newUser();
    const b = await newUser();
    expect(a.pb.authStore.isValid).toBe(true);
    expect(a.user.id).not.toBe(b.user.id);
  });
});
