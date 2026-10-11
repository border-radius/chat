import { deflateSync } from "node:zlib";
import { expect, type Page, test } from "@playwright/test";
import { PNG } from "../support/files.ts";
import { apiRoom, apiUser, attach, composer, login, message, openRoom, send, uniq } from "./fixtures.ts";

const png = (name: string) => ({ name, mimeType: "image/png", buffer: Buffer.from(PNG) });
/** A w×h PNG (a horizontal gradient). */
function sizedPng(name: string, w: number, h: number) {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2], 8); // 8-bit RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * (w * 3 + 1) + 1 + x * 3] = (x * 255) / w;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const buffer = Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  return { name, mimeType: "image/png", buffer };
}
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
  // fixed height whether or not the image has loaded: loading never moves the list
  expect((await tile.boundingBox())!.height).toBe(240);
  const img = tile.locator("img");
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
  expect((await tile.boundingBox())!.height).toBe(240);
  // uncropped, in the image's own aspect ratio (within the 400px width cap)
  const ratio = await img.evaluate((i: HTMLImageElement) => i.naturalWidth / i.naturalHeight);
  expect((await tile.boundingBox())!.width).toBeCloseTo(Math.min(400, Math.max(120, 240 * ratio)), 0);

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

test("images keep their shape: narrow ones are centred, and a sent one doesn't change width as it loads (§17.5)", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const room = await apiRoom(ada);
  const a = await openRoom(browser, ada, room);
  // Thumbnails load slowly, so the sent message shows its server tile before the image arrives.
  await a.route(/thumb=/, async (r) => {
    await new Promise((res) => setTimeout(res, 1000));
    await r.continue().catch(() => {});
  });
  await attach(a, [sizedPng("tall.png", 100, 1000)]);
  await send(a, "tall");
  const tile = message(a, "tall").locator("a.att-tile");
  await expect(tile).toHaveCount(1);
  // Not yet loaded, but already the preview's width (the 120px minimum: half the height).
  const img = tile.locator("img");
  expect(await img.evaluate((i: HTMLImageElement) => i.complete)).toBe(false);
  const box = (await tile.boundingBox())!;
  expect([box.width, box.height]).toEqual([120, 240]);
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
  // 24px of image, centred in its 120px tile.
  const pic = (await img.boundingBox())!;
  expect(pic.x - box.x + pic.width / 2).toBeCloseTo(60, 0);

  await attach(a, [sizedPng("wide.png", 1600, 900), sizedPng("square.png", 600, 600)]);
  await send(a, "pair");
  const widths = () =>
    message(a, "pair")
      .locator("a.att-tile")
      .evaluateAll((ts) => ts.map((t) => Math.round(t.getBoundingClientRect().width)));
  await expect(message(a, "pair").locator("a.att-tile")).toHaveCount(2);
  expect(
    await message(a, "pair")
      .locator("a.att-tile img")
      .evaluateAll((is) => is.some((i) => (i as HTMLImageElement).complete)),
  ).toBe(false);
  expect(await widths()).toEqual([213, 120]);
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
