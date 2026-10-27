import { expect } from "@playwright/test";
import { atPath, test } from "./fixtures.ts";

test("app boots to the guest home (Open Air rooms) without console errors; Log in is one click away", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/");

  await expect(page).toHaveTitle("Chirkle");
  await expect(page.getByRole("heading", { name: "Welcome!" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Rooms" })).toContainText("Open Air rooms");
  await page.locator("header.app-bar").getByRole("link", { name: "Log in" }).click();
  await expect(page).toHaveURL(atPath("/login"));
  await expect(page.getByRole("tab", { name: "Log in" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Email")).toBeVisible();
  expect(errors).toEqual([]);
});
