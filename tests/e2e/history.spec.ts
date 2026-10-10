import { expect, type Page, test } from "@playwright/test";
import { apiRoom, apiUser, headerAction, message, messages, openRoom, seed, send } from "./fixtures.ts";

const TOTAL = 2000;

async function domCount(page: Page) {
  return messages(page).count();
}

/** The first message in the window, and where it will sit on screen once the list is scrolled to the top. */
async function firstAtTop(page: Page) {
  return page.locator("ol.messages").evaluate((list) => {
    const li = list.querySelector<HTMLElement>("li.msg")!;
    const y = li.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    return { id: li.dataset.id!, text: li.querySelector(".body")!.textContent, y };
  });
}

const yOf = (page: Page, id: string) =>
  page.locator("ol.messages").evaluate((list, msgId) => {
    const li = list.querySelector<HTMLElement>(`li.msg[data-id="${msgId}"]`);
    return li ? li.getBoundingClientRect().top - list.getBoundingClientRect().top : null;
  }, id);

test("scroll back through 2000 messages to the first one and return to live", async ({ browser }) => {
  test.setTimeout(120_000);
  const ada = await apiUser("Ada");
  const bob = await apiUser("Bob");
  const room = await apiRoom(ada);
  seed(room, ada, TOTAL);
  const a = await openRoom(browser, ada, room);
  const list = a.locator("ol.messages");

  await expect(messages(a)).toHaveCount(50);
  await expect(messages(a).last().locator(".body")).toHaveText(`history ${TOTAL}`);

  // Scroll up until the beginning, checking the DOM bound and that the view never jumps.
  let maxDom = 0;
  for (let i = 0; i < 60 && !(await a.locator("li.beginning").isVisible()); i++) {
    // Measure before scrolling: locally the older page can land before a measurement taken afterwards.
    const anchor = await firstAtTop(a);
    await list.evaluate((el) => (el.scrollTop = 0));
    await expect(async () => {
      const changed = (await messages(a).first().locator(".body").textContent()) !== anchor.text;
      expect(changed || (await a.locator("li.beginning").count()) > 0).toBe(true);
    }).toPass({ timeout: 5_000 });
    maxDom = Math.max(maxDom, await domCount(a));
    if ((await messages(a).first().locator(".body").textContent()) !== anchor.text) {
      const y = await yOf(a, anchor.id);
      expect(Math.abs((y ?? Infinity) - anchor.y), "view jumped while loading older messages").toBeLessThan(2);
    }
  }
  await expect(a.locator("li.beginning")).toHaveText(`Beginning of #${room.name}`);
  await expect(messages(a).first().locator(".body")).toHaveText("history 1");
  expect(maxDom).toBeLessThanOrEqual(300);

  // Scroll down to the live edge.
  for (let i = 0; i < 60 && (await a.locator('li.sentinel[data-sentinel="bottom"]').count()); i++) {
    const lastText = await messages(a).last().locator(".body").textContent();
    await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(async () => {
      const changed = (await messages(a).last().locator(".body").textContent()) !== lastText;
      expect(changed || (await a.locator('li.sentinel[data-sentinel="bottom"]').count()) === 0).toBe(true);
    }).toPass({ timeout: 5_000 });
    expect(await domCount(a)).toBeLessThanOrEqual(300);
  }
  await expect(messages(a).last().locator(".body")).toHaveText(`history ${TOTAL}`);

  // At the live edge, a new message from Bob appears live.
  const b = await openRoom(browser, bob, room);
  await send(b, "fresh off the press");
  await expect(message(a, "fresh off the press")).toBeVisible({ timeout: 2_000 });

  // "Jump to beginning" goes straight to message 1.
  await headerAction(a, "Jump to beginning");
  await expect(messages(a).first().locator(".body")).toHaveText("history 1");
  await expect(a.locator("li.beginning")).toBeVisible();
});
