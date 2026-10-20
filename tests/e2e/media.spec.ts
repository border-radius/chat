import AxeBuilder from "@axe-core/playwright";
import { expect } from "@playwright/test";
import { PNG } from "../support/files.ts";
import { apiRoom, apiUser, message, openRoom, type Room, seed, test, type User } from "./fixtures.ts";
import { E2E_BASE } from "./paths.ts";

/** A message with images, through the API. */
async function sendImages(user: User, room: Room, text: string, names: string[]) {
  const form = new FormData();
  form.set("room", room.id);
  form.set("author", user.id);
  form.set("text", text);
  for (const n of names) form.append("files", new Blob([PNG], { type: "image/png" }), n);
  const res = await fetch(`${E2E_BASE}/api/collections/messages/records`, {
    method: "POST",
    headers: { authorization: user.token },
    body: form,
  });
  expect(res.ok).toBe(true);
}

const entry = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const s = history.state as { media?: string; viewer?: string } | null;
    return s?.viewer ? "viewer" : s?.media ? "media" : null;
  });

test("media grid: a room's images newest first, opened in the viewer, Show in chat goes far back (§30)", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const room = await apiRoom(ada);
  await sendImages(ada, room, "first pics", ["one.png", "two.png"]);
  await sendImages(ada, room, "later pic", ["three.png"]);
  // A long history after them: their messages aren't loaded when the room opens.
  seed(room, ada, 120, { startAt: Date.now() + 1000, stepMs: 10 });
  const a = await openRoom(browser, ada, room);
  await expect(message(a, "first pics")).toHaveCount(0);
  const roomUrl = a.url();

  const toggle = a.getByRole("button", { name: "Media", exact: true });
  await toggle.click();
  const grid = a.getByRole("dialog", { name: "Media" });
  await expect(grid).toBeVisible();
  const tiles = grid.locator("button.media-tile");
  await expect(tiles).toHaveCount(3);
  await expect(tiles.nth(0)).toHaveAccessibleName(/^three\.png, Ada, /);
  await expect(tiles.nth(2)).toHaveAccessibleName(/^one\.png, Ada, /);
  await expect(grid.locator("h3")).toHaveCount(1);
  await expect(tiles.nth(0).locator("img")).toHaveAttribute("src", /thumb=240x240/);
  await expect
    .poll(() =>
      tiles
        .nth(0)
        .locator("img")
        .evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0),
    )
    .toBe(true);
  expect(await entry(a)).toBe("media");
  const { violations } = await new AxeBuilder({ page: a }).include("dialog.media").withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
  await grid.screenshot({ path: process.env.MEDIA_SHOT ?? "test-results/media-grid.png" });

  // A tile opens the viewer over the grid, oldest first; closing it comes back to the grid.
  await tiles.nth(1).click();
  const viewer = a.locator("dialog.viewer");
  await expect(viewer.locator("h2")).toHaveText("two.png");
  await expect(viewer.locator(".viewer-count")).toHaveText("2 / 3");
  await expect.poll(() => entry(a)).toBe("viewer");
  await a.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(grid).toBeVisible();
  await expect(tiles.nth(1)).toBeFocused();
  await expect.poll(() => entry(a)).toBe("media");

  // Back from the viewer too.
  await tiles.nth(0).click();
  await expect(viewer.locator("h2")).toHaveText("three.png");
  await a.goBack();
  await expect(viewer).toHaveCount(0);
  await expect(grid).toBeVisible();

  // Show in chat: both close, and the message is loaded and shown.
  await tiles.nth(2).click();
  await expect(viewer.locator("h2")).toHaveText("one.png");
  await viewer.getByRole("button", { name: "Show in chat" }).click();
  await expect(a.locator("dialog.viewer, dialog.media")).toHaveCount(0);
  await expect(message(a, "first pics")).toBeVisible();
  await expect.poll(() => entry(a)).toBeNull();
  expect(a.url()).toBe(roomUrl);

  // Back closes the grid, staying in the room; Escape too, focus back on the button.
  await toggle.click();
  await expect(grid).toBeVisible();
  await a.goBack();
  await expect(grid).toHaveCount(0);
  expect(a.url()).toBe(roomUrl);
  await toggle.click();
  await expect(tiles).toHaveCount(3);
  await a.keyboard.press("Escape");
  await expect(grid).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await expect.poll(() => entry(a)).toBeNull();
});

test("media grid: an empty room says so (§30)", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const room = await apiRoom(ada);
  seed(room, ada, 3);
  const a = await openRoom(browser, ada, room);
  await a.getByRole("button", { name: "Media", exact: true }).click();
  const grid = a.getByRole("dialog", { name: "Media" });
  await expect(grid.getByRole("status")).toHaveText("No photos or videos here yet.");
  await expect(grid.locator("button.media-tile")).toHaveCount(0);
});
