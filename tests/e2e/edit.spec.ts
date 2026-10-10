import { expect, test } from "@playwright/test";
import { apiRoom, apiUser, composer, message, openRoom, send } from "./fixtures.ts";

test("an edit shows live for others with (edited); Up arrow edits my last message", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const bob = await apiUser("Bob");
  const room = await apiRoom(ada);
  const a = await openRoom(browser, ada, room);
  const b = await openRoom(browser, bob, room);

  await send(a, "teh plan");
  await expect(message(b, "teh plan")).toBeVisible();

  await composer(a).press("ArrowUp");
  const box = a.locator("textarea.edit-input");
  await expect(box).toBeFocused();
  await expect(box).toHaveValue("teh plan");
  await box.fill("the plan");
  await box.press("Enter");

  const edited = message(b, "the plan");
  await expect(edited).toBeVisible({ timeout: 1_000 });
  await expect(edited.locator(".edited")).toHaveText("(edited)");
  await expect(b.locator("ol.messages")).not.toContainText("teh plan");

  // Escape cancels an edit without changes
  const mine = message(a, "the plan");
  await mine.hover();
  await mine.getByRole("button", { name: "Edit" }).click();
  await a.locator("textarea.edit-input").fill("something else");
  await a.keyboard.press("Escape");
  await expect(message(a, "the plan")).toBeVisible();
  await expect(composer(a)).toBeFocused();
});
