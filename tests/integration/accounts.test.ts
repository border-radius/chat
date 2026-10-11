import { ClientResponseError } from "pocketbase";
import { describe, expect, it } from "vitest";
import { client, expectRejected, newUser, rawDb, status, uniq } from "./helpers.ts";

const signUp = (name: string) =>
  client()
    .collection("users")
    .create({ email: `${uniq()}@test.local`, password: "password-123", passwordConfirm: "password-123", name });

/** The field codes of a rejected SDK call. */
async function codes(p: Promise<unknown>): Promise<Record<string, string>> {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof ClientResponseError)) throw e;
    return Object.fromEntries(Object.entries(e.response.data ?? {}).map(([k, v]) => [k, (v as { code: string }).code]));
  }
  throw new Error("expected a rejection");
}

describe("unique display names (§22.1)", () => {
  it("a name can't be taken twice, whatever its case, width or invisible characters", async () => {
    const n = `Ada ${uniq()}`;
    await signUp(n);
    expect(await codes(signUp(n))).toEqual({ name: "validation_not_unique" });
    await expectRejected(signUp(n.toUpperCase()));
    await expectRejected(signUp(`${n}​`));
    await expectRejected(signUp(`  ${n.replace(" ", "   ")} `));
  });

  it("renaming onto someone else's name is refused; keeping your own is fine", async () => {
    const a = await newUser();
    const b = await newUser();
    expect(await codes(b.pb.collection("users").update(b.user.id, { name: a.user.name.toUpperCase() }))).toEqual({
      name: "validation_not_unique",
    });
    expect((await a.pb.collection("users").update(a.user.id, { name: a.user.name })).name).toBe(a.user.name);
    const renamed = `renamed-${uniq()}`;
    expect((await a.pb.collection("users").update(a.user.id, { name: renamed })).name).toBe(renamed);
    // The old name is free again.
    expect((await signUp(a.user.name)).name).toBe(a.user.name);
  });

  it("the key is hidden and can't be set by a client", async () => {
    const a = await newUser();
    const me = await a.pb.collection("users").update(a.user.id, { name_key: "something else" });
    expect(me).not.toHaveProperty("name_key");
    const db = rawDb();
    try {
      expect(db.prepare("SELECT name_key FROM users WHERE id = ?").get(a.user.id)).toEqual({ name_key: a.user.name });
    } finally {
      db.close();
    }
  });

  it("accounts that shared a name before (the migration's keys) can still change everything but the name", async () => {
    const a = await newUser();
    const legacy = await newUser();
    const db = rawDb({ write: true });
    try {
      db.prepare("UPDATE users SET name = ?, name_key = ? WHERE id = ?").run(
        a.user.name,
        `${a.user.name}#${legacy.user.id}`,
        legacy.user.id,
      );
    } finally {
      db.close();
    }
    await legacy.pb.send("/api/chat/password", { method: "POST", body: { oldPassword: legacy.password, password: "another-pass-1" } });
  });
});

describe("POST /api/chat/password (§22.2)", () => {
  const change = (pb: ReturnType<typeof client>, body: Record<string, unknown>) =>
    pb.send<{ token: string; record: { id: string } }>("/api/chat/password", { method: "POST", body });

  it("needs a session", async () => {
    expect(await status(change(client(), { oldPassword: "password-123", password: "new-password-1" }))).toBe(401);
  });

  it("checks the current password and the new one", async () => {
    const a = await newUser();
    expect(await codes(change(a.pb, { oldPassword: "wrong-password", password: "new-password-1" }))).toEqual({
      oldPassword: "validation_invalid_value",
    });
    expect(await codes(change(a.pb, { oldPassword: a.password, password: "" }))).toEqual({ password: "validation_required" });
    expect(Object.keys(await codes(change(a.pb, { oldPassword: a.password, password: "short" })))).toEqual(["password"]);
    expect(Object.keys(await codes(change(a.pb, { oldPassword: a.password, password: a.password })))).toEqual(["password"]);
    // Nothing changed.
    await client().collection("users").authWithPassword(a.email, a.password);
  });

  it("changes it, answers with a fresh session, and signs out every other one", async () => {
    const a = await newUser();
    const other = client();
    await other.collection("users").authWithPassword(a.email, a.password);
    const res = await change(a.pb, { oldPassword: a.password, password: "new-password-1" });
    expect(res.record.id).toBe(a.user.id);
    expect(res.token).toBeTruthy();

    // The old password no longer works; the new one does.
    await expectRejected(client().collection("users").authWithPassword(a.email, a.password));
    await client().collection("users").authWithPassword(a.email, "new-password-1");
    // The token from the answer works; tokens issued before don't.
    a.pb.authStore.save(res.token, a.pb.authStore.record);
    await a.pb.collection("users").authRefresh();
    expect(await status(other.collection("users").authRefresh())).toBe(401);
  });
});
