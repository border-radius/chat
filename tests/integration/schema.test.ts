import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import PocketBase, { type CollectionModel } from "pocketbase";
import { beforeAll, describe, expect, it } from "vitest";
import { LIMITS } from "../../web/src/lib/limits.ts";
import { SUPERUSER, startPocketBase } from "../support/pocketbase.ts";
import { adminClient } from "./helpers.ts";

type Field = { name: string; type: string; required?: boolean; min?: number; max?: number; [k: string]: unknown };
const fieldsOf = (c: CollectionModel) => Object.fromEntries((c.fields as Field[]).map((f) => [f.name, f]));
const norm = (sql: string) => sql.replace(/[`"]/g, "").replace(/\s+/g, " ").toLowerCase();

describe("schema (§5)", () => {
  let cols: Record<string, CollectionModel>;

  beforeAll(async () => {
    const pb = await adminClient();
    const all = await pb.collections.getFullList();
    cols = Object.fromEntries(all.map((c) => [c.name, c]));
  });

  it("users.name is required, 1–32 chars", () => {
    expect(fieldsOf(cols.users!).name).toMatchObject({ type: "text", required: true, min: 1, max: 32 });
  });

  it("the frontend's LIMITS (web/src/lib/limits.ts) match the schema", () => {
    expect(fieldsOf(cols.users!).name!.max).toBe(LIMITS.userName);
    expect(fieldsOf(cols.users!).password!.min).toBe(LIMITS.passwordMin);
    expect(fieldsOf(cols.rooms!).name!.max).toBe(LIMITS.roomName);
    expect(fieldsOf(cols.messages!).text!.max).toBe(LIMITS.messageText);
  });

  it("users do not require verification", () => {
    expect(cols.users!.authRule ?? "").not.toMatch(/verified/);
  });

  it("rooms fields and case-insensitive unique name index", () => {
    const f = fieldsOf(cols.rooms!);
    expect(f.name).toMatchObject({ type: "text", required: true, min: 1, max: 48 });
    expect(f.created_by).toMatchObject({ type: "relation", required: true, maxSelect: 1, collectionId: cols.users!.id });
    expect(f.archived).toMatchObject({ type: "bool" });
    expect(f.archived_at).toMatchObject({ type: "date" });
    expect(f.created).toMatchObject({ type: "autodate" });
    expect(f.updated).toMatchObject({ type: "autodate" });
    expect(cols.rooms!.indexes.map(norm)).toContainEqual(expect.stringMatching(/create unique index .* on rooms \(name collate nocase\)/));
  });

  it("messages fields and (room, created, id) index", () => {
    const f = fieldsOf(cols.messages!);
    expect(f.room).toMatchObject({ type: "relation", required: true, maxSelect: 1, cascadeDelete: true, collectionId: cols.rooms!.id });
    expect(f.author).toMatchObject({ type: "relation", required: true, maxSelect: 1, collectionId: cols.users!.id });
    expect(f.text).toMatchObject({ type: "text", required: false, max: 2000 });
    expect(f.edited_at).toMatchObject({ type: "date" });
    expect(f.deleted).toMatchObject({ type: "bool" });
    expect(f.deleted_at).toMatchObject({ type: "date" });
    expect(f.created).toMatchObject({ type: "autodate" });
    expect(f.updated).toMatchObject({ type: "autodate" });
    expect(cols.messages!.indexes.map(norm)).toContainEqual(
      expect.stringMatching(/create index idx_messages_room_created on messages \(room, created, id\)/),
    );
  });

  it("hidden_rooms fields and unique (user, room) index", () => {
    const f = fieldsOf(cols.hidden_rooms!);
    expect(f.user).toMatchObject({ type: "relation", required: true, maxSelect: 1, cascadeDelete: true, collectionId: cols.users!.id });
    expect(f.room).toMatchObject({ type: "relation", required: true, maxSelect: 1, cascadeDelete: true, collectionId: cols.rooms!.id });
    expect(f.created).toMatchObject({ type: "autodate" });
    expect(cols.hidden_rooms!.indexes.map(norm)).toContainEqual(
      expect.stringMatching(/create unique index .* on hidden_rooms \(user, room\)/),
    );
  });
});

describe("migrations", () => {
  it("are idempotent: restarting on the same data dir keeps the schema unchanged", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "chat-mig-"));
    const dataDir = join(tmp, "pb_data");
    const snapshot = async (url: string) => {
      const pb = new PocketBase(url);
      await pb.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
      const cols = await pb.collections.getFullList({ filter: "system = false" });
      return cols.map(({ updated: _u, created: _c, ...c }) => c).sort((a, b) => a.name.localeCompare(b.name));
    };
    try {
      const first = await startPocketBase({ dataDir });
      const before = await snapshot(first.url);
      await first.stop();

      const second = await startPocketBase({ dataDir });
      const after = await snapshot(second.url);
      await second.stop();

      expect(before.map((c) => c.name)).toEqual(expect.arrayContaining(["users", "rooms", "messages", "hidden_rooms"]));
      expect(after).toEqual(before);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
