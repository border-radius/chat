// Room view: service messages (§5.3), the app's own lines with no author.

import PocketBase from "pocketbase";
import { describe, expect, inject, it, vi } from "vitest";
import { newId } from "../../../../web/src/lib/id.ts";
import { seedMessages, signedUp } from "../../../support/api.ts";
import { SUPERUSER } from "../../../support/sql.ts";
import { list, me, mount, msgEls, newRoom, root, store, useRoomView, VIEWPORT } from "./harness.ts";

/** A service message, as the server's own code makes it (a superuser goes through the same hooks). */
async function service(room: string, text: string) {
  const admin = new PocketBase(inject("pbUrl"));
  await admin.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
  return admin.collection("messages").create({ room, text });
}

const lines = () => [...root.querySelectorAll<HTMLElement>("ol.messages li.service")];

describe("room view: service messages (§5.3)", () => {
  useRoomView();

  it("shows one as a line of its own, with its time and nothing to do on it; the next message starts a group", async () => {
    const room = await newRoom();
    await me.api.send({ id: newId(), room: room.id, text: "before" });
    await service(room.id, 'Telegram group "Friends" was connected to this room.');
    await me.api.send({ id: newId(), room: room.id, text: "after" });
    await mount(room);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]!.textContent).toMatch(/^Telegram group "Friends" was connected to this room\. · \d{1,2}:\d{2}/);
    expect(lines()[0]!.querySelector("button, input")).toBeNull();
    expect(msgEls().map((el) => el.classList.contains("group-start"))).toEqual([true, true]);
  });

  it("one made while the room is open shows live", async () => {
    const room = await newRoom();
    await mount(room);
    await service(room.id, "Telegram group was disconnected from this room.");
    await vi.waitFor(() =>
      expect(lines().map((l) => l.textContent!.split(" · ")[0])).toEqual(["Telegram group was disconnected from this room."]),
    );
  });

  it("a room whose first unread message is a service message opens at it, under the New line (§18.5)", async () => {
    const other = await signedUp("Other");
    const room = await newRoom(other);
    const read = await seedMessages(room.id, other.user.id, 70, { stepMs: 1, startAt: Date.now() - 1000 });
    await service(room.id, "Telegram group was disconnected from this room.");
    await seedMessages(room.id, other.user.id, 80, { stepMs: 1, startAt: Date.now() + 10 });
    await me.api.markRead(room.id, read[69]!.created);
    store.set({ unread: new Map([[room.id, 81]]) });
    await mount(room);
    const line = lines()[0]!;
    expect(line.previousElementSibling?.matches("li.new-line")).toBe(true);
    expect(list().scrollTop).toBe(line.offsetTop - VIEWPORT / 4);
  });
});
