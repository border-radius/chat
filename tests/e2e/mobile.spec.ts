import { expect, test } from "@playwright/test";
import { PNG } from "../support/files.ts";
import { apiRoom, apiSend, apiUser, attach, login, message, send } from "./fixtures.ts";

// No isMobile: Firefox does not support it, and CI runs all three engines. Viewport + touch is what matters here.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test("on a phone: list → room → send → back to the list", async ({ page }) => {
  const ada = await apiUser("Ada");
  const room = await apiRoom(ada);
  await login(page, ada);

  await page.getByRole("link", { name: room.name }).tap();
  await expect(page.locator("header.room-header h1")).toHaveText(`#${room.name}`);
  await expect(page.locator("aside.sidebar")).toBeHidden();

  const form = await page.locator("form.composer").boundingBox();
  expect(form).not.toBeNull();
  expect(form!.y + form!.height).toBeLessThanOrEqual(844 + 1);

  await send(page, "sent from my phone");
  await expect(message(page, "sent from my phone")).toBeVisible();
  // touch screens show message actions without hover
  // (toBeVisible() treats opacity:0 as visible, so check the computed opacity of the actions bar)
  const actions = message(page, "sent from my phone").locator(".actions");
  await expect(actions).toHaveCSS("opacity", "1");

  // BUG-32: another user's long name truncates; their message time stays on screen
  const long = await apiUser("Bartholomew Longname-Smithson");
  await apiSend(long, room, "from a long name");
  const theirs = message(page, "from a long name");
  await expect(theirs).toBeVisible();
  const time = await theirs.locator(".meta time").boundingBox();
  expect(time!.x + time!.width).toBeLessThanOrEqual(390);

  // attachments work on a phone too (§17.4)
  await attach(page, [{ name: "phone.png", mimeType: "image/png", buffer: Buffer.from(PNG) }]);
  await send(page, "with a picture");
  await expect(message(page, "with a picture").locator(".att-tile img")).toBeVisible();

  await page.getByRole("link", { name: "Back to rooms" }).tap();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByRole("navigation", { name: "Rooms" })).toBeVisible();
});
