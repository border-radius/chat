// The Android app's server additions (docs/ANDROID.md §9.4, §12.4), against their own PocketBase: App Links need
// ANDROID_CERT_SHA256 set.

import PocketBase, { type RecordModel } from "pocketbase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type PocketBaseServer, SUPERUSER, startPocketBase } from "../support/pocketbase.ts";

let server: PocketBaseServer;
let admin: PocketBase;

beforeAll(async () => {
  server = await startPocketBase({ env: { ANDROID_CERT_SHA256: "AB:CD:EF, 12:34:56" } });
  admin = new PocketBase(server.url);
  admin.autoCancellation(false);
  await admin.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
}, 60_000);

afterAll(async () => {
  await server?.stop();
});

describe("App Links and the minimum app version (§9.4, §12.4)", () => {
  it("serve assetlinks.json from ANDROID_CERT_SHA256, for the app's own id when ANDROID_APP_ID is unset", async () => {
    const res = await fetch(`${server.url}/.well-known/assetlinks.json`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: { namespace: "android_app", package_name: "com.chirkle.android", sha256_cert_fingerprints: ["AB:CD:EF", "12:34:56"] },
      },
    ]);
  });

  it("show min_android_version on the site record to everyone", async () => {
    const existing = await admin.collection("site").getList(1, 1);
    const site: RecordModel = existing.items[0] ?? (await admin.collection("site").create({ title: "Chirkle" }));
    await admin.collection("site").update(site.id, { min_android_version: 3 });
    const row = await new PocketBase(server.url).collection("site").getOne(site.id, { fields: "id,min_android_version" });
    expect(row.min_android_version).toBe(3);
  });

  it("no push collections any more (push removed, docs/REFACTOR.md round 4)", async () => {
    for (const name of ["push_tokens", "push_queue"]) await expect(admin.collections.getOne(name)).rejects.toMatchObject({ status: 404 });
  });
});
