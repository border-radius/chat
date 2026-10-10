// Server-side fixes from the QA pass: invisible text, look-alike and Unicode-case room names, account deletion,
// and the extra rate limits (pb_hooks/lib/chat.js, pb_migrations/1760000001_qa_fixes.js).

import { ClientResponseError } from "pocketbase";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { adminClient, client, expectRejected, newRoom, newUser, post, status, uniq } from "./helpers.ts";

const signUp = (name: string) =>
  client()
    .collection("users")
    .create({ email: `${uniq()}@test.local`, password: "password-123", passwordConfirm: "password-123", name });

/** The field error code a rejected save reports for `field`. */
async function codeOf(p: Promise<unknown>, field: string): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ClientResponseError) return (e.response.data as Record<string, { code?: string }>)[field]?.code;
    throw e;
  }
  return undefined;
}

describe("invisible text (BUG-10, BUG-11)", () => {
  it("rejects messages made only of zero-width characters, on create and on edit", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    await expectRejected(post(a, room.id, "​"));
    await expectRejected(post(a, room.id, "​⁠﻿ ‍"));
    const m = await post(a, room.id, "visible");
    await expectRejected(a.pb.collection("messages").update(m.id, { text: "​" }));
  });

  it("keeps joiners inside real text (emoji sequences, scripts that need ZWJ/ZWNJ)", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const family = "👨‍👩‍👧";
    expect((await post(a, room.id, family)).text).toBe(family);
  });

  it("rejects display names and room names made only of invisible characters", async () => {
    await expectRejected(signUp("​"));
    await expectRejected(signUp("‮​"));
    const a = await newUser();
    await expectRejected(a.pb.collection("rooms").create({ name: "​﻿", created_by: a.user.id }));
  });

  it("strips bidi overrides and zero-width spaces from names", async () => {
    expect((await signUp("‮admin")).name).toBe("admin");
    const a = await newUser();
    const n = `r${uniq()}`;
    const room = await a.pb.collection("rooms").create({ name: `${n}​`, created_by: a.user.id });
    expect(room.name).toBe(n);
  });
});

describe("room names are unique ignoring case, in any script (BUG-12)", () => {
  it("rejects names that differ only in non-ASCII case, case folding or invisible characters", async () => {
    const a = await newUser();
    const n = uniq();
    await newRoom(a, `Über-${n}`);
    expect(await codeOf(a.pb.collection("rooms").create({ name: `über-${n}`, created_by: a.user.id }), "name")).toBe(
      "validation_not_unique",
    );
    await newRoom(a, `straße-${n}`);
    await expectRejected(a.pb.collection("rooms").create({ name: `STRASSE-${n}`, created_by: a.user.id }));
    await newRoom(a, `general-${n}`);
    await expectRejected(a.pb.collection("rooms").create({ name: `general-${n}⁠`, created_by: a.user.id }));
  });

  it("a rename can't take another room's name, but can change the case of its own", async () => {
    const a = await newUser();
    const n = uniq();
    await newRoom(a, `Ärger-${n}`);
    const mine = await newRoom(a, `other-${n}`);
    expect(await codeOf(a.pb.collection("rooms").update(mine.id, { name: `ärger-${n}` }), "name")).toBe("validation_not_unique");
    expect((await a.pb.collection("rooms").update(mine.id, { name: `OTHER-${n}` })).name).toBe(`OTHER-${n}`);
  });

  it("the uniqueness key never leaves the server", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const seen = await a.pb.collection("rooms").getOne(room.id);
    expect(seen).not.toHaveProperty("name_key");
    // Not filterable either (hidden fields are superuser-only): rejected, or simply no match.
    const res = await a.pb
      .collection("rooms")
      .getList(1, 1, { filter: `name_key = "${room.name}"` })
      .catch(() => null);
    expect(res?.items ?? []).toHaveLength(0);
  });
});

describe("account deletion (BUG-08)", () => {
  it("is not offered through the API, for users with or without content", async () => {
    const empty = await newUser();
    await expectRejected(empty.pb.collection("users").delete(empty.user.id));
    const busy = await newUser();
    await post(busy, (await newRoom(busy)).id, "hello");
    await expectRejected(busy.pb.collection("users").delete(busy.user.id));
  });
});

describe("extra rate limits (BUG-22, BUG-23)", () => {
  it("migrations add limits for message edits/deletes and room creation", () => {
    const rules = inject("bootRateLimits").rules;
    expect(rules).toContainEqual(expect.objectContaining({ label: "messages:update", maxRequests: 20, duration: 10 }));
    expect(rules).toContainEqual(expect.objectContaining({ label: "rooms:create", maxRequests: 5, duration: 60 }));
    // the original rules are kept
    expect(rules).toContainEqual(expect.objectContaining({ label: "messages:create", maxRequests: 10, duration: 5 }));
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

    it("a burst of edits hits 429", async () => {
      const a = await newUser();
      const m = await post(a, (await newRoom(a)).id, "v0");
      const codes: number[] = [];
      for (let i = 0; i < 45; i++) codes.push(await status(a.pb.collection("messages").update(m.id, { text: `v${i + 1}` })));
      expect(codes.slice(0, 20)).toEqual(Array(20).fill(200));
      expect(codes).toContain(429);
    });

    it("a burst of room creation hits 429", async () => {
      const a = await newUser();
      const codes: number[] = [];
      for (let i = 0; i < 7; i++)
        codes.push(await status(a.pb.collection("rooms").create({ name: `flood-${uniq()}`, created_by: a.user.id })));
      expect(codes).toContain(429);
    });
  });
});
