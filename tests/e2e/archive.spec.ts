import { expect, test } from "@playwright/test";
import { apiRoom, apiUser, headerAction, messages, openRoom, seed } from "./fixtures.ts";

test("the creator archives a room: read-only for everyone, history still scrolls; unarchive restores", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const bob = await apiUser("Bob");
  const room = await apiRoom(ada);
  seed(room, ada, 120);
  const a = await openRoom(browser, ada, room);
  const b = await openRoom(browser, bob, room);

  // Only the creator is offered Archive
  await b.locator("header.room-header summary").click();
  await expect(b.locator("header.room-header .menu-items").getByRole("button", { name: "Archive room" })).toHaveCount(0);
  await b.keyboard.press("Escape");

  await headerAction(a, "Archive room");
  await expect(a.locator("header.room-header .menu-items")).toContainText("read-only for everyone");
  await a.locator("header.room-header .menu-items").getByRole("button", { name: "Archive", exact: true }).click();

  for (const page of [a, b]) {
    await expect(page.locator(".archived-banner")).toHaveText("This room is archived. History is read-only.");
    await expect(page.locator("form.composer")).toHaveCount(0);
    await expect(page.locator(`aside.sidebar [data-section="archived"] a[href="/r/${room.id}"]`)).toHaveCount(1);
  }
  await expect(b.getByRole("button", { name: "Edit" })).toHaveCount(0);

  // History still loads older pages
  await expect(messages(b)).toHaveCount(50);
  await b.locator("ol.messages").evaluate((el) => (el.scrollTop = 0));
  await expect(messages(b)).toHaveCount(100);

  await headerAction(a, "Unarchive room");
  await expect(b.locator("form.composer textarea")).toBeVisible();
  await expect(b.locator(".archived-banner")).toHaveCount(0);
});
