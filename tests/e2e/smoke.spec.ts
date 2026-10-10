import { expect, test } from "@playwright/test";

test("app loads without console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/");

  await expect(page).toHaveTitle("Chat");
  await expect(page.locator("#app")).toHaveText("hello");
  expect(errors).toEqual([]);
});
