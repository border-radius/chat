import { expect, test } from "@playwright/test";
import { apiRoom, apiUser, headerAction, openRoom } from "./fixtures.ts";

test("hiding a room is personal; a hidden room still opens by URL; unhide restores it", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const bob = await apiUser("Bob");
  const room = await apiRoom(ada);
  const a = await openRoom(browser, ada, room);
  const b = await openRoom(browser, bob, room);
  const inSection = (page: typeof a, section: string) =>
    page.locator(`aside.sidebar [data-section="${section}"] a[href="#/r/${room.id}"]`);

  await expect(inSection(a, "rooms")).toBeVisible();
  await headerAction(a, "Hide room");
  await expect(inSection(a, "rooms")).toHaveCount(0);
  await expect(inSection(a, "hidden")).toHaveCount(1);
  await expect(a.locator('aside.sidebar [data-section="hidden"] > summary')).toContainText("Hidden (1)");

  // Bob is unaffected
  await expect(inSection(b, "rooms")).toBeVisible();

  // Still reachable by URL, and posting works
  await a.goto("/#/");
  await a.goto(`/#/r/${room.id}`);
  await expect(a.locator("header.room-header h1")).toHaveText(`#${room.name}`);
  await expect(a.locator("form.composer textarea")).toBeVisible();

  await headerAction(a, "Unhide room");
  await expect(inSection(a, "rooms")).toBeVisible();
  await expect(inSection(a, "hidden")).toHaveCount(0);
});
