import { expect } from "@playwright/test";
import { apiRoom, apiSend, apiUser, atPath, login, message, test } from "./fixtures.ts";

const title = (page: import("@playwright/test").Page) => page.locator("header.room-header h1");

test("pages are paths: opened directly, followed in the app without reloading, Back and Forward work (§7.1)", async ({ page }) => {
  const ada = await apiUser("Ada");
  const one = await apiRoom(ada);
  const two = await apiRoom(ada);
  await login(page, ada);

  // Opened directly (the server serves the app for any page's path), and on a reload.
  await page.goto(`/r/${one.id}`);
  await expect(title(page)).toHaveText(`#${one.name}`);
  await page.reload();
  await expect(title(page)).toHaveText(`#${one.name}`);

  // A link in the app changes the page without loading it again.
  await page.evaluate(() => Object.assign(window, { __samePage: true }));
  await page.locator(`aside.sidebar a[href="/r/${two.id}"]`).click();
  await expect(title(page)).toHaveText(`#${two.name}`);
  await expect(page).toHaveURL(atPath(`/r/${two.id}`));
  await page.locator("a.me-link:visible").click();
  await expect(page).toHaveURL(atPath("/me"));

  await page.goBack();
  await expect(page).toHaveURL(atPath(`/r/${two.id}`));
  await expect(title(page)).toHaveText(`#${two.name}`);
  await page.goBack();
  await expect(page).toHaveURL(atPath(`/r/${one.id}`));
  await expect(title(page)).toHaveText(`#${one.name}`);
  await page.goForward();
  await expect(title(page)).toHaveText(`#${two.name}`);
  expect(await page.evaluate(() => (window as { __samePage?: boolean }).__samePage)).toBe(true);

  // Unknown pages go home.
  await page.goto("/no/such/page");
  await expect(page).toHaveURL(atPath("/"));
});

test("old #/ links still work, and show as paths (§7.1)", async ({ page }) => {
  const ada = await apiUser("Ada");
  const room = await apiRoom(ada);
  await login(page, ada);
  await page.goto(`/#/r/${room.id}`);
  await expect(title(page)).toHaveText(`#${room.name}`);
  await expect(page).toHaveURL(atPath(`/r/${room.id}`));

  // One opened in a tab that is already running the app.
  await page.evaluate(() => (location.hash = "#/me"));
  await expect(page).toHaveURL(atPath("/me"));
  await page.goBack();
  await expect(title(page)).toHaveText(`#${room.name}`);
});

test("a link in a message opens in a new tab, even one to a page of the app (§7.6.3)", async ({ page }) => {
  const ada = await apiUser("Ada");
  const room = await apiRoom(ada);
  const other = await apiRoom(ada);
  await login(page, ada);
  const target = `${new URL(page.url()).origin}/r/${other.id}`;
  await apiSend(ada, room, `over there: ${target}.`);
  await page.goto(`/r/${room.id}`);
  const link = message(page, "over there").getByRole("link", { name: target });
  await expect(link).toHaveAttribute("target", "_blank");

  const [tab] = await Promise.all([page.context().waitForEvent("page"), link.click()]);
  await tab.waitForURL(target);
  await expect(title(tab)).toHaveText(`#${other.name}`);
  // This tab stays in the room.
  await expect(page).toHaveURL(atPath(`/r/${room.id}`));
});
