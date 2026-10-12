import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { adminClient, newRoom, newUser, post, status } from "./helpers.ts";

const url = (path: string) => `${inject("pbUrl")}${path}`;

describe("security and cache headers (§5.6)", () => {
  beforeAll(async () => {
    const pub = inject("pbPublicDir");
    await mkdir(join(pub, "assets"), { recursive: true });
    await writeFile(join(pub, "index.html"), "<!doctype html><title>Chat</title>");
    await writeFile(join(pub, "assets/app-TEST1234.js"), "console.log(1)");
    await writeFile(join(pub, "assets/app.js"), "console.log(2)"); // unhashed, as written by npm run dev
  });

  it("GET / sends CSP, nosniff and referrer policy", async () => {
    const res = await fetch(url("/"));
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    for (const d of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "img-src 'self' data: blob:"]) {
      expect(csp).toContain(d);
    }
    expect(csp).not.toContain("unsafe-inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
  });

  it("API responses are also nosniff", async () => {
    const res = await fetch(url("/api/health"));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("the admin UI keeps PocketBase's own CSP, not the strict app CSP", async () => {
    const app = (await fetch(url("/"))).headers.get("content-security-policy");
    const admin = (await fetch(url("/_/"))).headers.get("content-security-policy");
    expect(admin).not.toBe(app);
  });

  it("hashed assets are cached immutably", async () => {
    const res = await fetch(url("/assets/app-TEST1234.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("unhashed assets (dev build) are not cached, so rebuilds show up on reload", async () => {
    const res = await fetch(url("/assets/app.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("a missing asset is a 404 that isn't cached, not the app's index.html cached for a year (an old build's chunk)", async () => {
    for (const path of ["/assets/viewer-GONE1234.js", "/assets/app-GONE1234.css", "/assets/nope.js", "/assets/"]) {
      const res = await fetch(url(path));
      expect(res.status, path).toBe(404);
      expect(res.headers.get("cache-control"), path).toBe("no-store");
      expect(res.headers.get("content-type"), path).not.toMatch(/html/);
    }
  });

  it("an unknown API path is a 404, not the app's index.html; the app's pages still get it", async () => {
    const api = await fetch(url("/api/nope"));
    expect(api.status).toBe(404);
    expect(api.headers.get("content-type")).toMatch(/json/);
    for (const path of ["/r/abc", "/me", "/r/abc/m/def"]) {
      const res = await fetch(url(path));
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toContain("<title>Chat</title>");
    }
  });

  it("index.html is never cached", async () => {
    for (const path of ["/", "/index.html"]) {
      const res = await fetch(url(path));
      expect(res.headers.get("cache-control"), path).toBe("no-cache");
    }
  });
});

describe("rate limits (§5.6)", () => {
  it("migrations enable a message-create limit of 10 per 5 seconds", () => {
    const rl = inject("bootRateLimits");
    expect(rl.enabled).toBe(true);
    expect(rl.rules).toContainEqual(expect.objectContaining({ label: "messages:create", maxRequests: 10, duration: 5 }));
    expect(rl.rules).toContainEqual(expect.objectContaining({ label: "users:create" }));
  });

  describe("when enabled", () => {
    beforeAll(async () => {
      const admin = await adminClient();
      await admin.settings.update({ rateLimits: { ...inject("bootRateLimits"), enabled: true } });
    });
    afterAll(async () => {
      const admin = await adminClient();
      await admin.settings.update({ rateLimits: { ...inject("bootRateLimits"), enabled: false } });
    });

    it("a burst of messages hits 429 after 10", async () => {
      const a = await newUser();
      const room = await newRoom(a);
      const codes: number[] = [];
      // 25 > 2 windows' worth, so a 429 shows up even if a window boundary falls inside the burst.
      for (let i = 0; i < 25; i++) codes.push(await status(post(a, room.id, `burst ${i}`)));
      expect(codes.slice(0, 10)).toEqual(Array(10).fill(200));
      expect(codes).toContain(429);
    });
  });
});
