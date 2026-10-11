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
  await expect(page.locator("section.welcome")).toBeHidden(); // a phone shows only the list
});

test("on a phone, focusing a text field can't zoom the page in: fields are 16px, double-tap zoom is off", async ({ page }) => {
  // iOS Safari zooms in on focus when a field's text is under 16px (and stays zoomed). Chromium doesn't, so check the
  // cause: every field's computed size. Pinch zoom deliberately stays available (WCAG 1.4.4).
  const ada = await apiUser("Ada");
  const room = await apiRoom(ada);
  await page.goto("/#/login");
  const sizes = () => page.locator("input:not([type=file]), textarea").evaluateAll((els) => els.map((e) => getComputedStyle(e).fontSize));
  for (const size of await sizes()) expect(parseFloat(size)).toBeGreaterThanOrEqual(16);

  await login(page, ada);
  await page.getByRole("link", { name: room.name }).tap();
  await expect(page.locator("form.composer textarea")).toHaveCSS("font-size", "16px");
  await page.getByRole("link", { name: "Back to rooms" }).tap();
  await page.locator("button.new-room-toggle").tap();
  for (const size of await sizes()) expect(parseFloat(size)).toBeGreaterThanOrEqual(16);
  await expect(page.locator("html")).toHaveCSS("touch-action", "manipulation");
  const viewport = await page.locator('meta[name="viewport"]').getAttribute("content");
  expect(viewport).not.toMatch(/user-scalable\s*=\s*no|maximum-scale/);
});
