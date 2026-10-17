import { expect, type Page } from "@playwright/test";
import { PNG } from "../support/files.ts";
import { apiRoom, apiUser, attach, login, logOut, message, send, test } from "./fixtures.ts";

// The app as an installable, offline-capable web app (DESIGN.md §27). Service workers are Chromium-tested here:
// Playwright's Firefox and WebKit don't run them the same way.
test.skip(({ browserName }) => browserName !== "chromium", "service workers: Chromium only");
test.use({ serviceWorkers: "allow" });

/** Wait until the service worker controls the page. */
const controlled = (page: Page) =>
  page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r));
  });

test("the manifest and its icons load; the service worker serves the app's shell offline", async ({ page, context }) => {
  await page.goto("/");
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  const manifest = await (await page.request.get(href!)).json();
  expect(manifest).toMatchObject({ name: "Chat", display: "standalone", start_url: "/" });
  for (const icon of manifest.icons as { src: string; type: string }[]) {
    const res = await page.request.get(icon.src);
    expect(res.ok(), icon.src).toBe(true);
    expect(res.headers()["content-type"], icon.src).toBe(icon.type);
  }

  // The worker takes over this page once active; the next load is kept for offline.
  await controlled(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Welcome!" })).toBeVisible();

  await context.setOffline(true);
  await page.goto("/login");
  await expect(page.locator("header.app-bar")).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await context.setOffline(false);
});

test("thumbnails are kept by the service worker across file tokens, and dropped on logout (§27.2)", async ({ page }) => {
  const ada = await apiUser("Ada");
  const room = await apiRoom(ada);
  await login(page, ada);
  await controlled(page);
  await page.goto(`/r/${room.id}`);
  await attach(page, [{ name: "photo.png", mimeType: "image/png", buffer: Buffer.from(PNG) }]);
  await send(page, "a picture");
  // Reloaded, the tile loads from the server through the worker.
  await page.reload();
  const img = message(page, "a picture").locator(".att-tile img");
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
  const src = new URL((await img.getAttribute("src"))!, page.url());
  expect(src.searchParams.get("thumb")).toBeTruthy();
  await expect.poll(() => page.evaluate(async () => (await (await caches.open("chat-files")).keys()).length)).toBe(1);

  const status = (url: string) => page.evaluate((u) => fetch(u, { cache: "no-store" }).then((r) => r.status), url);
  // Another token of the same user (here one the server refuses: a bad signature) gets the kept thumbnail.
  const token = src.searchParams.get("token")!;
  src.searchParams.set("token", token.replace(/\.[^.]+$/, ".bad"));
  expect((await page.request.get(src.href)).ok()).toBe(false);
  expect(await status(src.href)).toBe(200);
  // Another user's token never gets it: the worker passes the request on, and the server refuses it.
  const [head, payload] = token.split(".");
  const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
  const other = Buffer.from(JSON.stringify({ ...claims, id: "someoneelse0000" })).toString("base64url");
  src.searchParams.set("token", `${head}.${other}.bad`);
  expect(await status(src.href)).not.toBe(200);

  await logOut(page);
  await expect.poll(() => page.evaluate(() => caches.has("chat-files"))).toBe(false);
});
