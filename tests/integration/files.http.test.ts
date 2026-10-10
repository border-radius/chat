import { describe, expect, it } from "vitest";
import { newUser, pngFile } from "./helpers.ts";

describe("uploaded files are served inert (§15 shared rules)", () => {
  it("files carry a sandbox CSP and nosniff", async () => {
    const a = await newUser();
    const u = await a.pb.collection("users").update(a.user.id, { avatar: pngFile() });
    for (const thumb of [undefined, "48x48"]) {
      const res = await fetch(a.pb.files.getURL(u, u.avatar as string, thumb ? { thumb } : {}));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).toMatch(/default-src 'none'.*sandbox/);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });
});
