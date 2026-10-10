import { expect, test } from "@playwright/test";

test("app boots to the login screen without console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/");

  await expect(page).toHaveTitle("Chat");
  await expect(page).toHaveURL(/#\/login$/);
  await expect(page.getByRole("tab", { name: "Log in" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Email")).toBeVisible();
  expect(errors).toEqual([]);
});
