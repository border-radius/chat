// Push notifications for the Android app (docs/ANDROID.md §8, §9.4, §12.4), end to end against their own PocketBase
// (FCM and UnifiedPush on, the cron job off) and a stub FCM: its token endpoint checks the server's RS256 signature with
// the service account's public key, so the hand-made signing (pb_hooks/lib/google.js) is checked too.

import { generateKeyPairSync, verify } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import PocketBase, { type RecordModel } from "pocketbase";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { uniq } from "../support/ids.ts";
import { withName } from "../support/names.ts";
import { disableRateLimits, type PocketBaseServer, SUPERUSER, startPocketBase } from "../support/pocketbase.ts";
import { status } from "./helpers.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PROJECT = "chat-test";

interface Sent {
  token: string;
  data: Record<string, string>;
  priority: string;
  body: string;
}

let stub: Server;
let base = "";
let server: PocketBaseServer;
let admin: PocketBase;
const fcm: Sent[] = [];
const up: { path: string; body: string; urgency: string }[] = [];
const claims: Record<string, unknown>[] = [];
let badSignatures = 0;

const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

function body(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((ok) => {
    let s = "";
    req.on("data", (d) => (s += d));
    req.on("end", () => ok(s));
  });
}

beforeAll(async () => {
  stub = createServer(async (req, res) => {
    const text = await body(req);
    if (req.url === "/token") {
      const assertion = new URLSearchParams(text).get("assertion") ?? "";
      const [h, p, sig] = assertion.split(".");
      const ok = !!sig && verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, fromB64url(sig));
      if (!ok) {
        badSignatures++;
        return res.writeHead(400, { "content-type": "application/json" }).end('{"error":"invalid_grant"}');
      }
      claims.push(JSON.parse(fromB64url(p!).toString()));
      return res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ access_token: `tok-${claims.length}`, expires_in: 3600 }));
    }
    if (req.url === `/v1/projects/${PROJECT}/messages:send`) {
      if (!req.headers.authorization?.startsWith("Bearer tok-")) return res.writeHead(401).end();
      const { message } = JSON.parse(text);
      if (message.token === "dead-token") {
        return res
          .writeHead(404, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }));
      }
      fcm.push({ token: message.token, data: message.data, priority: message.android.priority, body: text });
      return res.writeHead(200, { "content-type": "application/json" }).end('{"name":"x"}');
    }
    if (req.url?.startsWith("/up/")) {
      up.push({ path: req.url, body: text, urgency: String(req.headers.urgency) });
      return res.writeHead(req.url === "/up/gone" ? 410 : 201).end();
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  const { port } = stub.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  const account = {
    type: "service_account",
    project_id: PROJECT,
    client_email: "push@chat-test.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    token_uri: `${base}/token`,
  };
  server = await startPocketBase({
    fixtureRoute: true,
    env: {
      FCM_SERVICE_ACCOUNT: JSON.stringify(account),
      FCM_ENDPOINT: base,
      UNIFIEDPUSH: "on",
      PUSH_ALLOW_HOSTS: `127.0.0.1:${port}`,
      PUSH_CRON: "off",
      ANDROID_APP_ID: "org.chat.android",
      ANDROID_CERT_SHA256: "AB:CD:EF, 12:34:56",
    },
  });
  await disableRateLimits(server.url);
  admin = new PocketBase(server.url);
  admin.autoCancellation(false);
  await admin.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
}, 60_000);

afterAll(async () => {
  await server?.stop();
  stub?.closeAllConnections();
  await new Promise((r) => stub?.close(r));
});

beforeEach(() => {
  fcm.length = 0;
  up.length = 0;
});

const tick = () => admin.send("/api/push/tick", { method: "POST" });

interface User {
  pb: PocketBase;
  user: RecordModel;
}

async function signUp(name = `user-${uniq()}`): Promise<User> {
  const pb = new PocketBase(server.url);
  pb.autoCancellation(false);
  const email = `${uniq()}@test.local`;
  const password = "password-123";
  await withName(server.url, name, () => pb.collection("users").create({ email, password, passwordConfirm: password, name }));
  const { record } = await pb.collection("users").authWithPassword(email, password);
  return { pb, user: record };
}

/** A user with a device registered under FCM token `token`. */
async function device(token = `fcm-${uniq()}`) {
  const u = await signUp();
  const row = await u.pb.collection("push_tokens").create({ user: u.user.id, token, provider: "fcm" });
  return { ...u, token, row };
}

const send = (u: User, room: string, text: string) => u.pb.collection("messages").create({ room, author: u.user.id, text });

describe("pushes (§8.2)", () => {
  it("go to everyone who can see the room but its author, with ids only, signed with the service account", async () => {
    const a = await device();
    const b = await device();
    const room = await a.pb.collection("rooms").create({ name: `p-${uniq()}`, created_by: a.user.id });
    const m = await send(a, room.id, "secret words");
    await tick();
    const mine = fcm.filter((s) => s.data.room === room.id);
    expect(mine.map((s) => s.token)).toContain(b.token);
    expect(mine.map((s) => s.token)).not.toContain(a.token);
    const toB = mine.find((s) => s.token === b.token)!;
    expect(toB.data).toEqual({ room: room.id, message: m.id, kind: "room", user: b.user.id });
    expect(toB.priority).toBe("NORMAL");
    expect(toB.body).not.toContain("secret words");
    expect(badSignatures).toBe(0);
    expect(claims[0]).toMatchObject({
      iss: "push@chat-test.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: `${base}/token`,
    });
  });

  it("leave out those who hid the room, read past the message, or can't see a private room", async () => {
    const a = await device();
    const member = await device();
    const hider = await device();
    const reader = await device();
    const outsider = await device();
    const created = await a.pb.collection("rooms").create({ name: `p-${uniq()}`, created_by: a.user.id, visibility: "private" });
    const room = await a.pb.collection("rooms").update(created.id, { members: [a.user.id, member.user.id, hider.user.id, reader.user.id] });
    await hider.pb.collection("hidden_rooms").create({ user: hider.user.id, room: room.id });
    const m = await send(a, room.id, "hi");
    await reader.pb.send("/api/chat/reads", { method: "POST", body: { room: room.id, at: m.created } });
    await tick();
    const to = fcm.filter((s) => s.data.room === room.id).map((s) => s.token);
    expect(to).toEqual([member.token]);
    expect(to).not.toContain(outsider.token);
  });

  it("go at high priority for a DM, and never for an archived room", async () => {
    const a = await device();
    const b = await device();
    const dm = await a.pb.send("/api/chat/dms", { method: "POST", body: { user: b.user.id } });
    await send(a, dm.id, "psst");
    await tick();
    expect(fcm.find((s) => s.data.room === dm.id)).toMatchObject({ token: b.token, priority: "HIGH", data: { kind: "dm" } });

    const room = await a.pb.collection("rooms").create({ name: `p-${uniq()}`, created_by: a.user.id });
    await send(a, room.id, "before");
    await a.pb.collection("rooms").update(room.id, { archived: true });
    fcm.length = 0;
    await tick();
    expect(fcm.filter((s) => s.data.room === room.id)).toEqual([]);
  });

  it("forget a token FCM no longer knows", async () => {
    const a = await device();
    const dead = await device("dead-token");
    const room = await a.pb.collection("rooms").create({ name: `p-${uniq()}`, created_by: a.user.id });
    await send(a, room.id, "hi");
    await tick();
    expect(await status(dead.pb.collection("push_tokens").getOne(dead.row.id))).toBe(404);
  });

  it("POST UnifiedPush endpoints directly, and forget one that is gone", async () => {
    const a = await device();
    const b = await signUp();
    const gone = await signUp();
    const endpoint = `${base}/up/${uniq()}`;
    await b.pb.collection("push_tokens").create({ user: b.user.id, token: endpoint, provider: "unifiedpush" });
    const goneRow = await gone.pb
      .collection("push_tokens")
      .create({ user: gone.user.id, token: `${base}/up/gone`, provider: "unifiedpush" });
    const room = await a.pb.collection("rooms").create({ name: `p-${uniq()}`, created_by: a.user.id });
    const m = await send(a, room.id, "hello");
    await tick();
    const hit = up.find((u) => base + u.path === endpoint)!;
    expect(JSON.parse(hit.body)).toEqual({ room: room.id, message: m.id, kind: "room", user: b.user.id });
    expect(await status(gone.pb.collection("push_tokens").getOne(goneRow.id))).toBe(404);
  });

  it("aren't queued for service messages", async () => {
    await device();
    const a = await signUp();
    const room = await a.pb.collection("rooms").create({ name: `p-${uniq()}`, created_by: a.user.id });
    await admin.collection("messages").create({ room: room.id, text: "Telegram group disconnected." });
    await tick();
    expect(fcm.filter((s) => s.data.room === room.id)).toEqual([]);
  });
});

describe("push_tokens (§8.1)", () => {
  it("are their owner's only: nobody lists them, others can't see or delete them", async () => {
    const a = await device();
    const b = await signUp();
    expect(await status(b.pb.collection("push_tokens").getOne(a.row.id))).toBe(404);
    expect(await status(b.pb.collection("push_tokens").getList(1, 50))).toBe(403);
    expect(await status(a.pb.collection("push_tokens").getList(1, 50))).toBe(403);
    expect((await a.pb.collection("push_tokens").getOne(a.row.id)).token).toBe(a.token);
    expect(await status(b.pb.collection("push_tokens").delete(a.row.id))).toBe(404);
    expect(await status(b.pb.collection("push_tokens").create({ user: a.user.id, token: `x-${uniq()}`, provider: "fcm" }))).toBe(400);
    expect(
      await status(new PocketBase(server.url).collection("push_tokens").create({ user: a.user.id, token: `x-${uniq()}`, provider: "fcm" })),
    ).toBe(400);
    await a.pb.collection("push_tokens").delete(a.row.id);
  });

  it("are shared by the accounts on one device, each push saying whose it is (ANDROID.md §17.4)", async () => {
    const a = await device();
    const b = await signUp();
    const row = await b.pb.collection("push_tokens").create({ user: b.user.id, token: a.token, provider: "fcm" });
    expect(row.user).toBe(b.user.id);
    expect((await a.pb.collection("push_tokens").getOne(a.row.id)).user).toBe(a.user.id);
    const c = await device();
    const room = await c.pb.collection("rooms").create({ name: `p-${uniq()}`, created_by: c.user.id });
    await send(c, room.id, "to both");
    await tick();
    const users = fcm.filter((s) => s.data.room === room.id && s.token === a.token).map((s) => s.data.user);
    expect(users.sort()).toEqual([a.user.id, b.user.id].sort());
  });

  it("replace their owner's row when registered again", async () => {
    const a = await device();
    const again = await a.pb.collection("push_tokens").create({ user: a.user.id, token: a.token, provider: "fcm" });
    expect(again.id).not.toBe(a.row.id);
    expect(await status(a.pb.collection("push_tokens").getOne(a.row.id))).toBe(404);
  });

  it("must suit their provider: UnifiedPush endpoints on public addresses only", async () => {
    const a = await signUp();
    for (const [token, provider] of [
      ["http://10.0.0.1/up", "unifiedpush"],
      ["https://localhost/up", "unifiedpush"],
      ["not a url", "unifiedpush"],
      ["https://example.com/x", "fcm"],
    ]) {
      expect(await status(a.pb.collection("push_tokens").create({ user: a.user.id, token, provider })), token).toBe(400);
    }
  });
});

describe("App Links and the minimum app version (§9.4, §12.4)", () => {
  it("serve assetlinks.json from ANDROID_APP_ID and ANDROID_CERT_SHA256", async () => {
    const res = await fetch(`${server.url}/.well-known/assetlinks.json`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: { namespace: "android_app", package_name: "org.chat.android", sha256_cert_fingerprints: ["AB:CD:EF", "12:34:56"] },
      },
    ]);
  });

  it("show min_android_version on the site record to everyone", async () => {
    const existing = await admin.collection("site").getList(1, 1);
    const site: RecordModel = existing.items[0] ?? (await admin.collection("site").create({ title: "Chat" }));
    await admin.collection("site").update(site.id, { min_android_version: 3 });
    const row = await new PocketBase(server.url).collection("site").getOne(site.id, { fields: "id,min_android_version" });
    expect(row.min_android_version).toBe(3);
  });
});
