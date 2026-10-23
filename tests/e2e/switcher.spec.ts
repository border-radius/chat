import AxeBuilder from "@axe-core/playwright";
import { expect } from "@playwright/test";
import { apiRoom, apiSend, apiUser, openRoom, test } from "./fixtures.ts";

test("jump to (§32): Ctrl+K from the composer, type, Enter; Ctrl+K Enter goes back; Ctrl+P too", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const first = await apiRoom(ada);
  const second = await apiRoom(ada);
  await apiSend(ada, second, "hello");
  const page = await openRoom(browser, ada, first);
  const composer = page.getByRole("textbox", { name: /message/i });
  await composer.focus();

  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Jump to" });
  const field = dialog.getByRole("combobox", { name: "Jump to" });
  await expect(field).toBeFocused();
  const { violations } = await new AxeBuilder({ page }).include("dialog.switcher").withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);

  await field.fill(`#${second.name}`);
  await expect(dialog.getByRole("option", { selected: true })).toContainText(second.name);
  await field.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/r/${second.id}$`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`#${second.name}`);

  // Nothing typed: the most recent first, the room you are in last. Enter goes back.
  await page.keyboard.press("Control+k");
  await expect(dialog.getByRole("option").last()).toContainText(second.name);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/r/${first.id}$`));

  // Ctrl+P instead of printing; Escape closes and gives focus back.
  await page.keyboard.press("Control+p");
  await expect(field).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
