// Server-side fixes from the fifth QA pass (docs/QA.md, BUG-51 … BUG-58): password changes, attachment names with
// quotes, and finding people whose names aren't plain ASCII.

import { describe, expect, inject, it } from "vitest";
import { type Api, createApi } from "../../web/src/api.ts";
import { newId } from "../../web/src/lib/id.ts";
import type { Message } from "../../web/src/lib/types.ts";
import { createClient } from "../../web/src/pb.ts";
import { client, eventually, newRoom, newUser, status, uniq } from "./helpers.ts";

const realClient = (): Api => createApi(createClient(inject("pbUrl")));

describe("passwords change only through POST /api/chat/password (BUG-53)", () => {
  it("refuses a password in a users update, which skipped the route's rate limit and checks", async () => {
    const u = await newUser();
    const update = u.pb
      .collection("users")
      .update(u.user.id, { oldPassword: u.password, password: "other-pass-1", passwordConfirm: "other-pass-1" });
    expect(await status(update)).toBe(404);
    expect(await status(client().collection("users").authWithPassword(u.email, u.password))).toBe(200);
    // The rest of the profile still saves.
    expect(await status(u.pb.collection("users").update(u.user.id, { name: `renamed-${uniq()}` }))).toBe(200);
  });
});

describe("attachment names keep their double quotes (BUG-54)", () => {
  it('stores "Q&A "v2".txt", which browsers send as "Q&A %22v2%22.txt"', async () => {
    const u = await newUser();
    const room = await newRoom(u);
    const name = 'Q&A "v2" notes.txt';
    const m = await u.pb.collection("messages").create({ room: room.id, author: u.user.id, text: "", files: [new File(["x"], name)] });
    expect(Object.values(m.file_names as Record<string, string>)).toEqual([name]);
  });
});

describe("user search ignores case beyond ASCII (BUG-55)", () => {
  it("finds “Иван”, “Élodie” and “Straße” however they are typed, as names are compared (§22.1)", async () => {
    const tag = uniq();
    const me = realClient();
    await me.signUp({ email: `${uniq()}@test.local`, password: "password-123", name: `searcher ${tag}` });
    for (const name of [`Иван ${tag}`, `Élodie ${tag}`, `Straße ${tag}`]) {
      await realClient().signUp({ email: `${uniq()}@test.local`, password: "password-123", name });
    }
    const names = async (q: string) => (await me.searchUsers(q)).map((u) => u.name);
    expect(await names(`иван ${tag}`)).toEqual([`Иван ${tag}`]);
    expect(await names(`ИВАН ${tag}`)).toEqual([`Иван ${tag}`]);
    expect(await names(`élodie ${tag}`)).toEqual([`Élodie ${tag}`]);
    expect(await names(`STRASSE ${tag}`)).toEqual([`Straße ${tag}`]);
    expect(await names(`searcher ${tag}`)).toEqual([]); // never yourself
    expect(await names("   ")).toEqual([]);
  });

  it("needs a session, and answers only the public profile", async () => {
    expect((await fetch(`${inject("pbUrl")}/api/chat/users?q=a`)).status).toBe(401);
    const me = realClient();
    const tag = uniq();
    await me.signUp({ email: `${uniq()}@test.local`, password: "password-123", name: `viewer ${tag}` });
    await realClient().signUp({ email: `${uniq()}@test.local`, password: "password-123", name: `shown ${tag}` });
    const [found] = await me.searchUsers(`shown ${tag}`);
    expect(Object.keys(found!).sort()).toEqual(["avatar", "id", "name"]);
  });
});

describe("a password change keeps realtime working where you are still logged in (BUG-52)", () => {
  it("events keep arriving after the token changes: the subscriptions are sent again with the new one", async () => {
    const ada = realClient();
    const bob = realClient();
    const tag = uniq();
    await ada.signUp({ email: `${uniq()}@test.local`, password: "password-123", name: `Ada ${tag}` });
    await bob.signUp({ email: `${uniq()}@test.local`, password: "password-123", name: `Bob ${tag}` });
    const room = await ada.createRoom(`pw-${tag}`);
    const got: Message[] = [];
    await ada.subscribeMessages(room.id, (_action, m) => got.push(m));
    try {
      await ada.changePassword("password-123", "new-password-1");
      await bob.send({ id: newId(), room: room.id, text: "after the change" });
      await eventually(() => expect(got.map((m) => m.text)).toContain("after the change"), 3_000);
    } finally {
      await ada.unsubscribeAll();
    }
  });
});
