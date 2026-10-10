import { expect, test } from "@playwright/test";
import { apiRoom, apiUser, message, openRoom, send } from "./fixtures.ts";

test("two users chat live; a delete becomes a placeholder for everyone and stays after reload", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const bob = await apiUser("Bob");
  const room = await apiRoom(ada);
  const a = await openRoom(browser, ada, room);
  const b = await openRoom(browser, bob, room);

  await send(a, "hi Bob");
  await expect(message(b, "hi Bob")).toBeVisible({ timeout: 1_000 });

  await send(b, "oops, wrong room");
  const mine = message(b, "oops, wrong room");
  await expect(message(a, "oops, wrong room")).toBeVisible({ timeout: 1_000 });

  await mine.hover();
  await mine.getByRole("button", { name: "Delete", exact: true }).click();
  await mine.getByRole("button", { name: "Delete message" }).click();

  const placeholder = a.locator("li.msg.deleted");
  await expect(placeholder.locator(".body")).toHaveText("Message deleted", { timeout: 1_000 });
  await expect(placeholder.locator(".author")).toHaveText("Bob");
  await expect(a.locator("ol.messages")).not.toContainText("oops, wrong room");

  await a.reload();
  await expect(a.locator("li.msg.deleted .body")).toHaveText("Message deleted");
  await expect(a.locator("ol.messages")).not.toContainText("oops, wrong room");
});
