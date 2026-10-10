import type PocketBase from "pocketbase";
import { beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../../web/src/api.ts";
import { first, latest, newer, older, PAGE_SIZE, type PageQuery } from "../../web/src/lib/cursor.ts";
import type { Message } from "../../web/src/lib/types.ts";
import { adminClient, newRoom, newUser, rawDb, type TestUser } from "./helpers.ts";

const TOTAL = 1000;
const TIES = 20;

type Msg = Message;

async function page(pb: PocketBase, q: PageQuery): Promise<Msg[]> {
  // Exactly the request the UI sends (§6): bound filter, sort, skipTotal, expand=author, lean fields.
  return createApi(pb).page(q);
}

describe("history pagination at scale (§6, §7.5)", () => {
  let reader: TestUser;
  let roomId: string;
  /** Message texts in true (created, id) order, as stored in the DB. */
  let expected: string[];

  beforeAll(async () => {
    const owner = await newUser();
    reader = await newUser();
    roomId = (await newRoom(owner)).id;

    // Seed through the API (admin: no rate limits, author = owner), 20 requests in flight at a time.
    const admin = await adminClient();
    const texts = Array.from({ length: TOTAL }, (_, i) => `m${String(i + 1).padStart(4, "0")}`);
    for (let i = 0; i < TOTAL; i += 20) {
      await Promise.all(
        texts.slice(i, i + 20).map((text) => admin.collection("messages").create({ room: roomId, author: owner.user.id, text })),
      );
    }

    // Force identical `created` values on a block of messages: the API can't set autodate fields.
    const db = rawDb({ write: true });
    try {
      const ids = db.prepare("SELECT id FROM messages WHERE room = ? ORDER BY created, id LIMIT ? OFFSET 500").all(roomId, TIES) as {
        id: string;
      }[];
      const stamp = db.prepare("SELECT created FROM messages WHERE id = ?").get(ids[0]!.id) as { created: string };
      const upd = db.prepare("UPDATE messages SET created = ? WHERE id = ?");
      for (const { id } of ids) upd.run(stamp.created, id);
      expected = (db.prepare("SELECT text FROM messages WHERE room = ? ORDER BY created, id").all(roomId) as { text: string }[]).map(
        (r) => r.text,
      );
    } finally {
      db.close();
    }
  }, 120_000);

  it("seeded a room with ties on created", () => {
    expect(expected).toHaveLength(TOTAL);
    const db = rawDb();
    try {
      const row = db
        .prepare("SELECT MAX(n) AS n FROM (SELECT COUNT(*) AS n FROM messages WHERE room = ? GROUP BY created)")
        .get(roomId) as { n: number };
      expect(row.n).toBe(TIES);
    } finally {
      db.close();
    }
  });

  it("walking older pages from the latest reaches the first message, each exactly once, in order", async () => {
    const seen: Msg[] = [];
    let batch = await page(reader.pb, latest(roomId));
    let requests = 1;
    while (batch.length) {
      seen.unshift(...batch.slice().reverse());
      if (batch.length < PAGE_SIZE) break;
      batch = await page(reader.pb, older(roomId, batch[batch.length - 1]!));
      requests++;
    }
    expect(seen.map((m) => m.text)).toEqual(expected);
    expect(seen[0]!.expand?.author?.name).toBeTruthy();
    expect(JSON.stringify(seen)).not.toContain("@test.local");
    expect(requests).toBe(Math.ceil(TOTAL / PAGE_SIZE) + (TOTAL % PAGE_SIZE === 0 ? 1 : 0));
  });

  it("walking newer pages from the first gives the same sequence", async () => {
    const seen: Msg[] = [];
    let batch = await page(reader.pb, first(roomId));
    while (batch.length) {
      seen.push(...batch);
      if (batch.length < PAGE_SIZE) break;
      batch = await page(reader.pb, newer(roomId, batch[batch.length - 1]!));
    }
    expect(seen.map((m) => m.text)).toEqual(expected);
  });

  it("cursor queries are served by idx_messages_room_created", () => {
    const db = rawDb();
    try {
      const plans = [
        "SELECT * FROM messages WHERE room = ? AND (created < ? OR (created = ? AND id < ?)) ORDER BY created DESC, id DESC LIMIT 50",
        "SELECT * FROM messages WHERE room = ? AND (created > ? OR (created = ? AND id > ?)) ORDER BY created ASC, id ASC LIMIT 50",
      ].map((sql) =>
        (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(roomId, "x", "x", "x") as { detail: string }[]).map((r) => r.detail).join(" | "),
      );
      for (const plan of plans) {
        expect(plan).toContain("idx_messages_room_created");
        expect(plan).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/);
      }
    } finally {
      db.close();
    }
  });
});
