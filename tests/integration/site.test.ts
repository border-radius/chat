import { ClientResponseError, type RecordModel } from "pocketbase";
import { afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { adminClient, client, newUser, pngFile, status, uniq } from "./helpers.ts";

const signUp = (extra: Record<string, unknown> = {}) =>
  client()
    .collection("users")
    .create({ email: `${uniq()}@test.local`, password: "password-123", passwordConfirm: "password-123", name: `user-${uniq()}`, ...extra });

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

describe("site settings (§24)", () => {
  let site: RecordModel;
  const setSite = async (data: Record<string, unknown>) => (await adminClient()).collection("site").update(site.id, data);

  beforeAll(async () => {
    site = await (await adminClient()).collection("site").getFirstListItem("", { sort: "created" });
  });
  // Files run one at a time: put the site back for the next one.
  afterEach(async () => {
    await setSite({ title: "Chirkle", logo: null, invite_only: false, invite_code: "" });
  });

  it("there is one record, readable by anyone, without its invite code", async () => {
    const u = await newUser();
    await setSite({ invite_only: true, invite_code: "secret-code" });
    const { items } = await client().collection("site").getList(1, 10);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: "Chirkle", invite_only: true });
    expect(items[0]).not.toHaveProperty("invite_code");
    expect(await u.pb.collection("site").getOne(site.id)).not.toHaveProperty("invite_code");
  });

  it("only superusers change it", async () => {
    const u = await newUser();
    expect(await status(u.pb.collection("site").update(site.id, { title: "Mine" }))).toBe(403);
    expect(await status(u.pb.collection("site").create({ title: "Mine" }))).toBe(403);
    expect(await status(u.pb.collection("site").delete(site.id))).toBe(403);
    expect(await status(client().collection("site").update(site.id, { invite_only: true }))).toBe(403);
    expect((await setSite({ title: "Acme chat" })).title).toBe("Acme chat");
  });

  it("the logo is a public image", async () => {
    const rec = await setSite({ logo: pngFile("logo.png") });
    const res = await fetch(client().files.getURL(rec, rec.logo));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    // An SVG logo can't run scripts, even opened on its own.
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>';
    const withSvg = await setSite({ logo: new File([svg], "logo.svg", { type: "image/svg+xml" }) });
    const svgRes = await fetch(client().files.getURL(withSvg, withSvg.logo));
    expect(svgRes.status).toBe(200);
    expect(svgRes.headers.get("content-security-policy")).toContain("sandbox");
    expect(await codes(setSite({ logo: new File(["hi"], "logo.txt", { type: "text/plain" }) }))).toEqual({
      logo: "validation_invalid_mime_type",
    });
  });

  it("anyone signs up while it isn't invite-only; an invite code sent anyway is ignored", async () => {
    expect((await signUp()).id).toBeTruthy();
    expect((await signUp({ invite_code: "whatever" })).id).toBeTruthy();
  });

  it("invite-only: signing up needs the code", async () => {
    await setSite({ invite_only: true, invite_code: "Open-Sesame" });
    expect(await codes(signUp())).toEqual({ invite_code: "validation_required" });
    expect(await codes(signUp({ invite_code: "open-sesame" }))).toEqual({ invite_code: "validation_invalid_invite" });
    expect(await codes(signUp({ invite_code: "Open-Sesam" }))).toEqual({ invite_code: "validation_invalid_invite" });
    const user = await signUp({ invite_code: "  Open-Sesame " });
    expect(user.id).toBeTruthy();
    expect(user).not.toHaveProperty("invite_code");
  });

  it("invite-only without a code: signups are closed", async () => {
    await setSite({ invite_only: true, invite_code: "" });
    expect(await codes(signUp())).toEqual({ invite_code: "validation_signups_closed" });
    expect(await codes(signUp({ invite_code: "anything" }))).toEqual({ invite_code: "validation_signups_closed" });
  });

  it("existing accounts keep logging in; superusers still create accounts", async () => {
    const u = await newUser();
    await setSite({ invite_only: true, invite_code: "code-1" });
    await client().collection("users").authWithPassword(u.email, u.password);
    const admin = await adminClient();
    const made = await admin.collection("users").create({
      email: `${uniq()}@test.local`,
      password: "password-123",
      passwordConfirm: "password-123",
      name: `user-${uniq()}`,
    });
    expect(made.id).toBeTruthy();
  });

  it("the web app manifest (§27) is named after the site, guests included", async () => {
    const manifest = async () => {
      const res = await fetch(`${inject("pbUrl")}/manifest.webmanifest`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/manifest+json");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      return res.json();
    };
    expect(await manifest()).toMatchObject({ name: "Chirkle", short_name: "Chirkle", start_url: "/", scope: "/", display: "standalone" });
    await setSite({ title: "Acme chat" });
    const m = await manifest();
    expect(m).toMatchObject({ name: "Acme chat", short_name: "Acme chat" });
    expect(m.icons).toContainEqual({ src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" });
    expect(m.icons).toContainEqual({ src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" });
  });
});
