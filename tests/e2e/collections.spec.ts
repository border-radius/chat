import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { PNG } from "../support/files.ts";
import { apiRoom, apiUser, composer, message, openRoom, type Room, test, type User } from "./fixtures.ts";
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
  return (await res.json()) as { id: string; files: string[] };
}

async function apiCollection(user: User, name: string, isPublic: boolean) {
  const res = await fetch(`${E2E_BASE}/api/collections/collections/records`, {
    method: "POST",
    headers: { authorization: user.token, "content-type": "application/json" },
    body: JSON.stringify({ owner: user.id, name, public: isPublic }),
  });
  expect(res.ok).toBe(true);
  return (await res.json()) as { id: string };
}

const sidebarRow = (page: Page, name: string) => page.locator(`.room-section[data-section="collections"] li a`, { hasText: name });

async function saveTo(page: Page, text: string, collection: string) {
  const tile = message(page, text).locator(".att-cell").first();
  await tile.hover();
  await message(page, text).screenshot({ path: "test-results/collection-save.png" });
  await tile.getByRole("button", { name: /to collection$/ }).click();
  const menu = page.getByRole("dialog", { name: "Save to collection" });
  await menu.getByRole("checkbox", { name: collection }).check();
  await expect(menu.getByRole("status")).toHaveText("Saved.");
  await menu.getByRole("button", { name: "Close" }).click();
  await expect(menu).toHaveCount(0);
}

test("collections: make one, save from the chat, follow, see what's new, attach with its badge (§31)", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const bob = await apiUser("Bob");
  const room = await apiRoom(ada);
  await sendImages(ada, room, "a cat", ["cat.png"]);
  await sendImages(ada, room, "a dog", ["dog.png"]);
  const a = await openRoom(browser, ada, room);

  // A new collection from the sidebar's "+": its page, empty.
  await a.getByRole("button", { name: "New collection" }).click();
  const create = a.getByRole("dialog", { name: "New collection" });
  await create.getByRole("textbox", { name: "Name" }).fill("Pets");
  await create.getByRole("checkbox", { name: /Public/ }).check();
  await create.getByRole("button", { name: "Create" }).click();
  await expect(a.getByRole("heading", { level: 1, name: "Pets" })).toBeVisible();
  await expect(a.getByText("Nothing here yet.", { exact: false })).toBeVisible();
  await expect(sidebarRow(a, "Pets")).toHaveAttribute("aria-current", "page");
  const collUrl = a.url();

  // Saved from a message's tile (the collections icon), it shows on the page.
  await a.goBack();
  await saveTo(a, "a cat", "Pets");
  await sidebarRow(a, "Pets").click();
  await expect(a.locator(".coll-grid .media-tile")).toHaveCount(1);
  await expect(a.locator(".coll-grid .media-tile")).toHaveAccessibleName("cat.png");
  await expect(a.locator(".coll-head .coll-meta")).toHaveText("Yours · Public · 1 item");

  // Bob subscribes; Ada adds another; Bob's sidebar says 1 new, live.
  const b = await openRoom(browser, bob, room);
  await b.goto(collUrl);
  await b.getByRole("button", { name: "Subscribe" }).click();
  await expect(b.getByRole("button", { name: "Unsubscribe" })).toBeVisible();
  await expect(sidebarRow(b, "Pets")).toContainText("Ada");
  await b.goto(`/r/${room.id}`);
  await a.goBack();
  await saveTo(a, "a dog", "Pets");
  await expect(sidebarRow(b, "Pets").locator(".badge")).toHaveText("1 new");

  // Opened: the new one is highlighted, and the count goes.
  await sidebarRow(b, "Pets").click();
  await expect(b.locator(".coll-cell.new")).toHaveCount(1);
  await expect(b.locator(".coll-cell.new .media-tile")).toHaveAccessibleName("dog.png, new");
  await expect(b.locator(".coll-new")).toHaveText("1 new since your last visit");
  await expect(sidebarRow(b, "Pets").locator(".badge")).toHaveCount(0);
  const { violations } = await new AxeBuilder({ page: b }).include("section.collection").withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
  await b.screenshot({ path: "test-results/collection-page.png" });

  // Bob attaches from the collection: the message shows it with a badge that links to it.
  await b.goto(`/r/${room.id}`);
  await b.getByRole("button", { name: "Attach from collections" }).click();
  const picker = b.getByRole("dialog", { name: "Attach from collections" });
  await picker.getByRole("button", { name: "dog.png" }).click();
  await picker.getByRole("button", { name: "Attach 1" }).click();
  await expect(b.locator(".tray-item")).toContainText("From a collection");
  await b.locator("form.composer").screenshot({ path: "test-results/collection-tray.png" });
  await composer(b).fill("from Ada's pets");
  await composer(b).press("Enter");
  const sent = message(b, "from Ada's pets");
  await expect(sent.locator(".att-tile img")).toBeVisible();
  await expect(sent.locator(".att-tile img")).toHaveJSProperty("complete", true);
  const badge = sent.getByRole("link", { name: "Pets" });
  await expect(badge).toHaveAttribute("href", collUrl.replace(/^.*?\/c\//, "/c/"));
  await sent.screenshot({ path: "test-results/collection-badge.png" });

  // Private now: Bob's badge says so, and isn't a link; Ada's still names it.
  await fetch(`${E2E_BASE}/api/collections/collections/records/${collUrl.split("/c/")[1]}`, {
    method: "PATCH",
    headers: { authorization: ada.token, "content-type": "application/json" },
    body: JSON.stringify({ public: false }),
  });
  await b.reload();
  await expect(message(b, "from Ada's pets").locator(".att-src")).toHaveText("Private collection");
  await expect(message(b, "from Ada's pets").locator("a.att-src")).toHaveCount(0);
  await expect(sidebarRow(b, "Pets")).toHaveCount(0);
  await a.reload();
  await expect(message(a, "from Ada's pets").getByRole("link", { name: /Pets/ })).toBeVisible();
});

test("collections: the viewer saves too, and unticking takes it out (§31)", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const room = await apiRoom(ada);
  await sendImages(ada, room, "in the viewer", ["sun.png"]);
  await apiCollection(ada, "Skies", false);
  const a = await openRoom(browser, ada, room);
  await expect(sidebarRow(a, "Skies")).toBeVisible();
  await message(a, "in the viewer").locator("a.att-tile").click();
  const viewer = a.locator("dialog.viewer");
  await viewer.getByRole("button", { name: "Save to collection" }).click();
  const menu = a.getByRole("dialog", { name: "Save to collection" });
  await menu.getByRole("checkbox", { name: "Skies" }).check();
  await expect(menu.getByRole("status")).toHaveText("Saved.");
  // Unticked: taken out again.
  await menu.getByRole("checkbox", { name: "Skies" }).uncheck();
  await expect(menu.getByRole("status")).toHaveText("Removed.");
  await a.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(viewer).toBeVisible();
});
