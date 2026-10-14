import { expect, test } from "@playwright/test";

// The app as an installable, offline-capable web app (DESIGN.md §27). Service workers are Chromium-tested here:
// Playwright's Firefox and WebKit don't run them the same way.
test.skip(({ browserName }) => browserName !== "chromium", "service workers: Chromium only");
test.use({ serviceWorkers: "allow" });

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
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r));
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Welcome!" })).toBeVisible();

  await context.setOffline(true);
  await page.goto("/login");
  await expect(page.locator("header.app-bar")).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await context.setOffline(false);
});
