import { expect, type Page, test } from "@playwright/test";
import { PNG } from "../support/files.ts";
import { apiRoom, apiUser, attach, composer, login, message, openRoom, send, uniq } from "./fixtures.ts";

const png = (name: string) => ({ name, mimeType: "image/png", buffer: Buffer.from(PNG) });
const pdf = { name: "notes.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") };

/** HTTP status of a URL fetched from inside the page, bypassing the HTTP cache (files are cached for 30 days). */
const statusOf = (page: Page, url: string) => page.evaluate((u) => fetch(u, { cache: "no-store" }).then((r) => r.status), url);

test("attachments: an image and a PDF go live to others, open, and disappear with the message (§17)", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const bob = await apiUser("Bob");
  const room = await apiRoom(ada);
  const a = await openRoom(browser, ada, room);
  const b = await openRoom(browser, bob, room);

  await attach(a, [png("photo.png"), pdf]);
  await expect(a.locator(".tray-item img")).toHaveCount(1);
  await send(a, "look at this");
  await expect(a.locator(".tray-item")).toHaveCount(0);

  const theirs = message(b, "look at this");
  const tile = theirs.locator(".att-tile");
  await expect(tile).toHaveCount(1);
  // fixed size whether or not the image has loaded: loading never moves the list
  expect(await tile.boundingBox()).toMatchObject({ width: 240, height: 180 });
  await expect.poll(() => tile.locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  expect(await tile.boundingBox()).toMatchObject({ width: 240, height: 180 });

  const chip = theirs.locator("a.att-file");
  await expect(chip).toHaveText("notes.pdf");
  const imageUrl = (await tile.getAttribute("href"))!;
  const pdfUrl = (await chip.getAttribute("href"))!;
  expect(await statusOf(b, imageUrl)).toBe(200);
  expect(await statusOf(b, pdfUrl)).toBe(200);

  // Delete: the attachments go away for Bob, and their URLs stop working.
  const mine = message(a, "look at this");
  await mine.hover();
  await mine.getByRole("button", { name: "Delete", exact: true }).click();
  await mine.getByRole("button", { name: "Delete message" }).click();
  await expect(b.locator("li.msg.deleted")).toHaveCount(1);
  await expect(b.locator(".att-tile, .att-file")).toHaveCount(0);
  expect(await statusOf(b, pdfUrl)).toBe(404);
});

test("a DM's attachments can't be fetched by others, not even with the URL (§17.3)", async ({ browser }) => {
  const tag = uniq();
  const ada = await apiUser(`Ada ${tag}`);
  const bob = await apiUser(`Bob ${tag}`);
  const cat = await apiUser(`Cat ${tag}`);
  const page = async () => (await browser.newContext({ viewport: { width: 1100, height: 720 } })).newPage();
  const a = await page();
  const c = await page();
  await login(a, ada);
  await login(c, cat);
  await a.getByRole("button", { name: "New message" }).click();
  await a.getByLabel("Find someone to message").fill(bob.name);
  await a.locator(".user-search button.person", { hasText: bob.name }).click();
  await expect(composer(a)).toHaveAttribute("placeholder", `Message ${bob.name}`);
  await attach(a, [pdf]);
  await send(a, "for your eyes only");
  const href = (await message(a, "for your eyes only").locator("a.att-file").getAttribute("href"))!;
  expect(await statusOf(a, href)).toBe(200);
  const unsigned = href.replace(/[?&]token=[^&]*/, "");
  expect([403, 404]).toContain(await statusOf(c, unsigned));
});

test("an uploaded HTML file never runs on our origin (§17, XSS)", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const room = await apiRoom(ada);
  const a = await openRoom(browser, ada, room);
  const html = `<title>file</title><script>document.title = "pwned"; try { window.opener.__pwned = 1 } catch {}</script>`;
  await attach(a, [{ name: "evil.html", mimeType: "text/html", buffer: Buffer.from(html) }]);
  await send(a, "open me");
  const href = (await message(a, "open me").locator("a.att-file").getAttribute("href"))!;
  // Served as a download, never rendered; and sandboxed even if it were.
  const [disposition, csp] = await a.evaluate(
    (u) => fetch(u, { cache: "no-store" }).then((r) => [r.headers.get("content-disposition"), r.headers.get("content-security-policy")]),
    href,
  );
  expect(disposition).toMatch(/^attachment/);
  expect(csp).toMatch(/sandbox/);
  const tab = await a.context().newPage();
  await expect(tab.goto(href)).rejects.toThrow(/Download is starting/);
  expect(await tab.title()).not.toBe("pwned");
  expect(await a.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
});
