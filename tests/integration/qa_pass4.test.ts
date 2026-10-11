// Server-side fixes from the fourth QA pass (docs/QA.md, BUG-43 … BUG-50): emails that differ only in case, and room
// names typed with their "#".

import { describe, expect, it } from "vitest";
import { client, expectRejected, newUser, rawDb, status, uniq } from "./helpers.ts";

const PASSWORD = "password-123";
const signUp = (email: string, name = "Casey") =>
  client().collection("users").create({ email, password: PASSWORD, passwordConfirm: PASSWORD, name });

describe("emails ignore capitalization (BUG-47)", () => {
  it("stores a new email in lower case and logs in however it is capitalized", async () => {
    const id = uniq();
    await signUp(`Casey.${id}@Example.TEST`);
    const pb = client();
    const { record } = await pb.collection("users").authWithPassword(`casey.${id}@example.test`, PASSWORD);
    expect(record.email).toBe(`casey.${id}@example.test`);
    expect(await status(client().collection("users").authWithPassword(`CASEY.${id}@EXAMPLE.TEST`, PASSWORD))).toBe(200);
    expect(await status(client().collection("users").authWithPassword(`casey.${id}@example.test`, "wrong-password"))).toBe(400);
  });

  it("refuses a second account for the same address in another case", async () => {
    const id = uniq();
    await signUp(`dup.${id}@test.local`);
    await expectRejected(signUp(`Dup.${id}@Test.Local`));
  });

  it("an update that doesn't touch the email leaves an existing one as it is", async () => {
    const u = await newUser();
    const legacy = `Legacy.${uniq()}@Test.Local`;
    rawDb({ write: true }).prepare("UPDATE users SET email = ? WHERE id = ?").run(legacy, u.user.id);
    await u.pb.collection("users").update(u.user.id, { name: "renamed" });
    expect(rawDb().prepare("SELECT email FROM users WHERE id = ?").get(u.user.id)).toEqual({ email: legacy });
    // ...and logs in as typed.
    expect(await status(client().collection("users").authWithPassword(legacy, u.password))).toBe(200);
  });

  it("an unknown email still gets the usual refusal", async () => {
    expect(await status(client().collection("users").authWithPassword(`nobody.${uniq()}@test.local`, PASSWORD))).toBe(400);
  });
});

describe("room names typed with their # (BUG-48)", () => {
  it("drops leading #s, so “#name” is the room “name”, shown as #name", async () => {
    const a = await newUser();
    const name = `hash-${uniq()}`;
    const room = await a.pb.collection("rooms").create({ name: `## ${name}`, created_by: a.user.id });
    expect(room.name).toBe(name);
    await expectRejected(a.pb.collection("rooms").create({ name, created_by: a.user.id }));
    await expectRejected(a.pb.collection("rooms").create({ name: " # ", created_by: a.user.id }));
    // A # inside the name stays.
    const inner = await a.pb.collection("rooms").create({ name: `c#-${uniq()}`, created_by: a.user.id });
    expect(inner.name).toMatch(/^c#-/);
  });
});
