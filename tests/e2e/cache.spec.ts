import { expect, type Page, test } from "@playwright/test";
import { apiRoom, apiSend, apiUser, login, logOut, message, openRoom } from "./fixtures.ts";

/** Hold every message list request until the returned function is called (a slow network). */
async function holdMessages(page: Page): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  await page.route("**/api/collections/messages/records?**", async (route) => {
    await held;
    await route.continue().catch(() => {}); // the page may have gone on meanwhile
  });
  return release;
}

/** How many rooms the cache (IndexedDB) keeps, or with `roomId`, the texts it keeps for that room. */
const kept = (page: Page, roomId?: string) =>
  page.evaluate(
    (roomId) =>
      new Promise<number | string[]>((resolve, reject) => {
        const req = indexedDB.open("chat", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("rooms");
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const store = req.result.transaction("rooms").objectStore("rooms");
          const get = roomId ? store.get(roomId) : store.count();
          get.onsuccess = () => {
            req.result.close();
            const r = get.result as number | { items: { text: string }[] } | undefined;
            resolve(typeof r === "number" ? r : (r?.items.map((m) => m.text) ?? []));
          };
        };
      }),
    roomId,
  );

test("a room opens at once from the cache, after switching and after a reload, and the cache goes with the session (§7.5)", async ({
  page,
}) => {
  const ada = await apiUser("Ada");
  const first = await apiRoom(ada);
  const second = await apiRoom(ada);
  await apiSend(ada, first, "kept from last time");
  await apiSend(ada, second, "in the second room");
  await login(page, ada);
  await page.goto(`/r/${first.id}`);
  await expect(message(page, "kept from last time")).toBeVisible();

  // Switching back while the network is slow: the room shows what it had, then the new message.
  await page.locator(`a[href="/r/${second.id}"]`).click();
  await expect(message(page, "in the second room")).toBeVisible();
  await apiSend(ada, first, "sent meanwhile");
  let release = await holdMessages(page);
  await page.locator(`a[href="/r/${first.id}"]`).click();
  await expect(message(page, "kept from last time")).toBeVisible();
  await expect(message(page, "sent meanwhile")).toHaveCount(0);
  release();
  await expect(message(page, "sent meanwhile")).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });

  // After a reload too, before the room list is in (the window is saved a second after it last changed: a reload
  // sooner may show it without its newest message, which the first page then brings).
  await expect.poll(() => kept(page)).toBe(2);
  release = await holdMessages(page);
  await page.reload();
  await expect(message(page, "kept from last time")).toBeVisible();
  release();
  await expect(message(page, "sent meanwhile")).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });

  await logOut(page);
  await expect.poll(() => kept(page)).toBe(0);
});

test("a room with unread messages is prefetched: opening it shows them at once (§7.5)", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const bob = await apiUser("Bob");
  const room = await apiRoom(ada);
  const lobby = await apiRoom(ada);
  const page = await openRoom(browser, bob, lobby);
  const row = page.locator(`li[data-room-id="${room.id}"]`);

  // Bob has never opened the room: all he got is the unread event, without its text.
  await apiSend(ada, room, "new while away");
  await expect(row.locator(".badge")).toHaveText("1 unread", { timeout: 2_000 });
  await expect.poll(() => kept(page, room.id)).toEqual(["new while away"]);

  const release = await holdMessages(page);
  await row.getByRole("link").click();
  await expect(message(page, "new while away")).toBeVisible();
  // Seen, though the first page never came: back in the lobby, the room isn't unread.
  await page.locator(`li[data-room-id="${lobby.id}"]`).getByRole("link").click();
  await page.waitForTimeout(500);
  await expect(row.locator(".badge")).toHaveCount(0);
  release();
  await page.close();
});
