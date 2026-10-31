import { expect } from "@playwright/test";
import { PNG } from "../support/files.ts";
import { apiRoom, apiUser, login, message, openRoom, send, test } from "./fixtures.ts";

test("an avatar set on the profile page shows next to your messages for others (§15)", async ({ browser, page }) => {
  const ada = await apiUser("Ada Lovelace");
  const bob = await apiUser("Bob");
  const room = await apiRoom(ada);

  await login(page, ada);
  await page.locator("a.me-link:visible").click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.locator(".profile-picture .avatar")).toHaveText("AL");
  await page.locator(".profile input[type=file]").setInputFiles({ name: "me.png", mimeType: "image/png", buffer: Buffer.from(PNG) });
  await expect(page.locator(".profile-picture img.avatar")).toHaveAttribute("src", /thumb=96x96/);
  await expect(page.locator("a.me-link:visible img.avatar")).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove" })).toBeVisible();

  const b = await openRoom(browser, bob, room);
  await page.goto(`/r/${room.id}`);
  await send(page, "hello with a face");
  const mine = message(b, "hello with a face");
  await expect(mine.locator("img.avatar")).toHaveAttribute("src", /thumb=48x48/);
  await expect.poll(() => mine.locator("img.avatar").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);

  await page.goto("/me");
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.locator(".profile-picture .avatar")).toHaveText("AL");
  await b.reload();
  await expect(message(b, "hello with a face").locator(".avatar")).toHaveText("AL");
});
