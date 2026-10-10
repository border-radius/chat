import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { apiRoom, apiSend, apiUser, login } from "./fixtures.ts";

async function seriousViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`);
}

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test("login, rooms, room and archived room have no serious accessibility violations", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByLabel("Email")).toBeVisible();
      expect(await seriousViolations(page), "login").toEqual([]);

      const ada = await apiUser("Ada");
      const bob = await apiUser("Bob");
      const room = await apiRoom(ada);
      const archived = await apiRoom(ada);
      await apiSend(ada, room, "hello");
      await apiSend(bob, room, "hi there");
      await login(page, ada);
      expect(await seriousViolations(page), "rooms").toEqual([]);

      await page.goto(`/#/r/${room.id}`);
      await expect(page.locator("li.msg")).toHaveCount(2);
      expect(await seriousViolations(page), "room").toEqual([]);

      await page.goto(`/#/r/${archived.id}`);
      await page.locator("header.room-header summary").click();
      await page.locator(".menu-items").getByRole("button", { name: "Archive room" }).click();
      await page.locator(".menu-items").getByRole("button", { name: "Archive", exact: true }).click();
      await expect(page.locator(".archived-banner")).toBeVisible();
      expect(await seriousViolations(page), "archived room").toEqual([]);
    });
  });
}
