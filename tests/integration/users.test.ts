import { describe, expect, it } from "vitest";
import { client, expectRejected, newRoom, newUser, post, status, uniq } from "./helpers.ts";

describe("users rules (§5.5)", () => {
  it("anyone can sign up and use the account immediately, without verification", async () => {
    const u = await newUser();
    expect(u.user.verified).toBe(false);
    const room = await newRoom(u);
    expect((await post(u, room.id, "first!")).text).toBe("first!");
  });

  it("rejects a missing, blank or over-long name", async () => {
    const pb = client();
    const base = { password: "password-123", passwordConfirm: "password-123" };
    await expectRejected(pb.collection("users").create({ ...base, email: `${uniq()}@test.local` }));
    await expectRejected(pb.collection("users").create({ ...base, email: `${uniq()}@test.local`, name: "   " }));
    await expectRejected(pb.collection("users").create({ ...base, email: `${uniq()}@test.local`, name: "x".repeat(33) }));
  });

  it("trims names", async () => {
    const created = await client()
      .collection("users")
      .create({ email: `${uniq()}@test.local`, password: "password-123", passwordConfirm: "password-123", name: "  padded  " });
    expect(created.name).toBe("padded");
  });

  it("cannot sign up with a public email", async () => {
    const pb = client();
    await expectRejected(
      pb.collection("users").create({
        email: `${uniq()}@test.local`,
        password: "password-123",
        passwordConfirm: "password-123",
        name: "visible",
        emailVisibility: true,
      }),
    );
  });

  it("authenticated users can list others but never see their email", async () => {
    const a = await newUser();
    const b = await newUser();
    const seen = await a.pb.collection("users").getOne(b.user.id);
    expect(seen.name).toBe(b.user.name);
    expect(seen.email).toBeFalsy();
    const list = await a.pb.collection("users").getFullList({ filter: `id = "${b.user.id}"` });
    expect(list).toHaveLength(1);
    expect(list[0]!.email).toBeFalsy();
  });

  it("anonymous users cannot list or view users", async () => {
    const b = await newUser();
    const anon = client();
    expect((await anon.collection("users").getList(1, 50)).items).toHaveLength(0);
    expect(await status(anon.collection("users").getOne(b.user.id))).toBe(404);
  });

  it("a user can update their own name but not someone else's", async () => {
    const a = await newUser();
    const b = await newUser();
    expect((await a.pb.collection("users").update(a.user.id, { name: "renamed" })).name).toBe("renamed");
    await expectRejected(a.pb.collection("users").update(b.user.id, { name: "hacked" }));
  });

  it("a user cannot make their email public", async () => {
    const a = await newUser();
    await expectRejected(a.pb.collection("users").update(a.user.id, { emailVisibility: true }));
  });
});
