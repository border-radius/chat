import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import PocketBase from "pocketbase";
import { describe, expect, it } from "vitest";
import { SUPERUSER, startPocketBase } from "../support/pocketbase.ts";

async function trustedProxy(url: string): Promise<{ headers: string[]; useLeftmostIP: boolean }> {
  const admin = new PocketBase(url);
  await admin.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
  return ((await admin.settings.getAll()) as { trustedProxy: { headers: string[]; useLeftmostIP: boolean } }).trustedProxy;
}

/** A failed login from `forwardedFor` (as the proxy would send it): its status. */
const failLogin = async (url: string, forwardedFor: string) =>
  (
    await fetch(`${url}/api/collections/users/auth-with-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": forwardedFor },
      body: JSON.stringify({ identity: "nobody@example.com", password: "wrong-password" }),
    })
  ).status;

describe("TRUSTED_PROXY: the client IP behind a reverse proxy", () => {
  it("trusts the proxy's (rightmost) X-Forwarded-For address, so rate limits are per client; off and unset", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "chat-proxy-"));
    try {
      const behind = await startPocketBase({ dataDir, env: { TRUSTED_PROXY: "X-Forwarded-For" } });
      try {
        expect(await trustedProxy(behind.url)).toEqual({ headers: ["X-Forwarded-For"], useLeftmostIP: false });
        // *:auth allows 2 per 3 s per IP. Different clients each get their own; a spoofed leftmost entry changes nothing.
        expect(await failLogin(behind.url, "203.0.113.1")).toBe(400);
        expect(await failLogin(behind.url, "203.0.113.2")).toBe(400);
        expect(await failLogin(behind.url, "203.0.113.3")).toBe(400);
        expect(await failLogin(behind.url, "203.0.113.3")).toBe(400);
        expect(await failLogin(behind.url, "198.51.100.9, 203.0.113.3")).toBe(429);
      } finally {
        await behind.stop();
      }

      // Unset: whatever is configured stays.
      const kept = await startPocketBase({ dataDir, env: { TRUSTED_PROXY: "" } });
      try {
        expect((await trustedProxy(kept.url)).headers).toEqual(["X-Forwarded-For"]);
      } finally {
        await kept.stop();
      }

      const off = await startPocketBase({ dataDir, env: { TRUSTED_PROXY: "off" } });
      try {
        expect((await trustedProxy(off.url)).headers).toEqual([]);
      } finally {
        await off.stop();
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
