import { expect, test } from "@playwright/test";
import { apiRoom, apiUser, login } from "./fixtures.ts";

test("a reload keeps the session; logging out guards rooms even via the back button", async ({ page }) => {
  const ada = await apiUser("Ada");
  const room = await apiRoom(ada);
  await login(page, ada);
  await page.goto(`/#/r/${room.id}`);
  await expect(page.locator("header.room-header h1")).toHaveText(`#${room.name}`);

  await page.reload();
  await expect(page).toHaveURL(new RegExp(`#/r/${room.id}$`));
  await expect(page.locator("header.room-header h1")).toHaveText(`#${room.name}`);
  await expect(page.locator("header.app-bar")).toContainText("Ada");

  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/#\/login$/);
  expect(await page.evaluate(() => localStorage.getItem("pocketbase_auth"))).toBeNull();

  await page.goBack();
  await expect(page).toHaveURL(/#\/login$/);
  await expect(page.locator("ol.messages")).toHaveCount(0);
  await expect(page.getByLabel("Email")).toBeVisible();
});
