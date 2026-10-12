import { expect, test } from "@playwright/test";
import { apiRoom, apiUser, atPath, login, logOut } from "./fixtures.ts";

test("a reload keeps the session; logging out guards rooms even via the back button (§23.3)", async ({ page }) => {
  const ada = await apiUser("Ada");
  const room = await apiRoom(ada);
  await login(page, ada);
  await page.goto(`/r/${room.id}`);
  await expect(page.locator("header.room-header h1")).toHaveText(`#${room.name}`);

  await page.reload();
  await expect(page).toHaveURL(atPath(`/r/${room.id}`));
  await expect(page.locator("header.room-header h1")).toHaveText(`#${room.name}`);
  await expect(page.locator("header.app-bar")).toContainText("Ada");

  await logOut(page);
  await expect(page).toHaveURL(atPath("/"));
  await expect(page.locator("header.app-bar").getByRole("link", { name: "Log in" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("pocketbase_auth"))).toBeNull();

  // Back to the (public) room: as a guest it is out of reach.
  await page.goBack();
  await expect(page.getByText("This room doesn't exist.")).toBeVisible();
  await expect(page.locator("ol.messages")).toHaveCount(0);
});

test("tabs share the session: a logout or a login as someone else in one tab is followed by the others", async ({ page, context }) => {
  const ada = await apiUser("Ada");
  const bob = await apiUser("Bob");
  const room = await apiRoom(ada);
  await login(page, ada);
  const other = await context.newPage();
  await other.goto(`/r/${room.id}`);
  await expect(other.locator("header.app-bar")).toContainText("Ada");

  await logOut(page);
  await expect(other).toHaveURL(atPath("/"));
  await expect(other.locator("ol.messages")).toHaveCount(0);

  await login(page, bob);
  await expect(other).toHaveURL(atPath("/"));
  await expect(other.locator("header.app-bar")).toContainText("Bob");
  await other.goto(`/r/${room.id}`);
  await other.getByLabel("Message", { exact: true }).fill("from the other tab");
  await other.keyboard.press("Enter");
  await expect(other.locator("li.msg").filter({ hasText: "from the other tab" }).locator(".author")).toHaveText("Bob");
});
