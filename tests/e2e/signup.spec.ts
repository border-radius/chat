import { expect, test } from "@playwright/test";
import { composer, message, send, uniq } from "./fixtures.ts";

test("sign up, create a room, send the first message", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/");
  await expect(page).toHaveURL(/#\/login$/);
  await page.getByRole("tab", { name: "Sign up" }).click();
  await page.getByLabel("Display name").fill("Grace");
  await page.getByLabel("Email").fill(`grace-${uniq()}@test.local`);
  await page.getByLabel("Password").fill("password-123");
  await page.getByRole("button", { name: "Sign up" }).click();

  await expect(page).toHaveURL(/#\/$/);
  await expect(page.locator("header.app-bar")).toContainText("Grace");
  await expect(page.getByRole("navigation", { name: "Rooms" })).toBeVisible();
  // With no room open: the room list is a sidebar on the left, a greeting beside it.
  const welcome = page.getByRole("heading", { name: "Welcome, Grace!" });
  await expect(welcome).toBeVisible();
  const side = (await page.locator("aside.sidebar").boundingBox())!;
  const greet = (await welcome.boundingBox())!;
  expect(side.x).toBe(0);
  expect(greet.x).toBeGreaterThan(side.x + side.width);

  const name = `general-${uniq()}`;
  await page.getByLabel("New room").fill(name);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/#\/r\/[a-z0-9]{15}$/);
  await expect(page.locator("header.room-header h1")).toHaveText(`#${name}`);
  await expect(page.locator("li.beginning")).toHaveText(`Beginning of #${name}`);

  await send(page, "hello");
  const hello = message(page, "hello");
  await expect(hello).toBeVisible();
  await expect(hello).not.toHaveClass(/pending/);
  await expect(hello.locator(".author")).toHaveText("Grace");
  await expect(composer(page)).toHaveValue("");
  expect(errors).toEqual([]);
});
