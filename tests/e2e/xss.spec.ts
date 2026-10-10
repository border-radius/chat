import { expect, test } from "@playwright/test";
import { apiRoom, apiUser, composer, message, openRoom, send } from "./fixtures.ts";

const IMG = `<img src=x onerror="window.__pwned=1">`;
const SVG = `<svg onload="window.__pwned=2"></svg><script>window.__pwned=3</script>`;

test("markup in messages renders as text and never runs, after sending and after editing", async ({ browser }) => {
  const ada = await apiUser(`<b>Ada</b>`);
  const bob = await apiUser("Bob");
  const room = await apiRoom(ada, `<i>room</i>-${Date.now()}`);
  const a = await openRoom(browser, ada, room);
  const b = await openRoom(browser, bob, room);

  await send(a, IMG);
  for (const page of [a, b]) {
    await expect(message(page, IMG)).toBeVisible();
    await expect(page.locator("ol.messages img, ol.messages svg, ol.messages script")).toHaveCount(0);
    await expect(page.locator("li.msg .author").first()).toHaveText("<b>Ada</b>");
  }

  await composer(a).press("ArrowUp");
  await a.locator("textarea.edit-input").fill(SVG);
  await a.locator("textarea.edit-input").press("Enter");
  await expect(message(b, SVG)).toBeVisible();

  for (const page of [a, b]) {
    await expect(page.locator("ol.messages img, ol.messages svg, ol.messages script")).toHaveCount(0);
    await expect(page.locator("header.room-header h1")).toHaveText(`#${room.name}`);
    expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
  }
});
