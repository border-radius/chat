import { describe, expect, it } from "vitest";
import { expectRejected, newRoom, newUser, PNG, pngFile, post } from "./helpers.ts";

describe("avatars (§15)", () => {
  it("a user can set, replace and remove their avatar; old files are deleted", async () => {
    const a = await newUser();
    const set = await a.pb.collection("users").update(a.user.id, { avatar: pngFile() });
    expect(set.avatar).toMatch(/\.png$/);
    const first = a.pb.files.getURL(set, set.avatar);
    expect((await fetch(first)).status).toBe(200);

    const replaced = await a.pb.collection("users").update(a.user.id, { avatar: pngFile("other.png") });
    expect(replaced.avatar).not.toBe(set.avatar);
    expect((await fetch(first)).status).toBe(404);

    const removed = await a.pb.collection("users").update(a.user.id, { avatar: null });
    expect(removed.avatar).toBe("");
    expect((await fetch(a.pb.files.getURL(replaced, replaced.avatar))).status).toBe(404);
  });

  it("serves the 48x48 and 96x96 thumbnails as images", async () => {
    const a = await newUser();
    const u = await a.pb.collection("users").update(a.user.id, { avatar: pngFile() });
    for (const thumb of ["48x48", "96x96"]) {
      const res = await fetch(a.pb.files.getURL(u, u.avatar, { thumb }));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^image\//);
    }
  });

  it("rejects SVG, non-images and files over 2 MB", async () => {
    const a = await newUser();
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], "x.svg", { type: "image/svg+xml" });
    await expectRejected(a.pb.collection("users").update(a.user.id, { avatar: svg }));
    await expectRejected(a.pb.collection("users").update(a.user.id, { avatar: new File(["<html>"], "x.png", { type: "text/html" }) }));
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set(PNG);
    await expectRejected(a.pb.collection("users").update(a.user.id, { avatar: new File([big], "big.png", { type: "image/png" }) }));
  });

  it("nobody can set someone else's avatar", async () => {
    const a = await newUser();
    const b = await newUser();
    await expectRejected(b.pb.collection("users").update(a.user.id, { avatar: pngFile() }));
  });

  it("other users see the avatar filename, never the email", async () => {
    const a = await newUser();
    const b = await newUser();
    const u = await a.pb.collection("users").update(a.user.id, { avatar: pngFile() });
    const seen = await b.pb.collection("users").getOne(a.user.id);
    expect(seen.avatar).toBe(u.avatar);
    expect(seen.email).toBeFalsy();
    const room = await newRoom(b);
    await post(a, room.id, "hi");
    const [m] = (await b.pb.collection("messages").getList(1, 1, { filter: `room = "${room.id}"`, expand: "author" })).items;
    expect(m!.expand!.author.avatar).toBe(u.avatar);
  });
});

describe("long avatar names (BUG-35)", () => {
  it("accepts an avatar with a long non-Latin name", async () => {
    const a = await newUser();
    const png = Uint8Array.from(
      atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
      (c) => c.charCodeAt(0),
    );
    const avatar = new File([png], `${"é".repeat(150)}.png`, { type: "image/png" });
    const u = await a.pb.collection("users").update(a.user.id, { avatar });
    expect(u.avatar).toMatch(/\.png$/);
  });
});
