import { test, expect } from "@playwright/test";

/**
 * A signed-out click on a link in one of our emails. Code signup gives an
 * account a random password nobody is shown, so the page the middleware
 * sends it to asks for a code first, keeps where the link was going (query
 * and all), and has the password one tap away for whoever has one.
 */
test("a signed-out email link lands on the code form, keeping where it was going", async ({ page }) => {
  await page.goto("/articles?status=review");
  await expect(page).toHaveURL(/\/signin\?next=%2Farticles%3Fstatus%3Dreview$/);
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByRole("button", { name: "Email me a sign-in code" })).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.locator('input[type="hidden"][name="next"]')).toHaveValue("/articles?status=review");

  // The password, in place, with the address already typed kept.
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByRole("link", { name: "Use a password instead" }).click();
  await expect(page.getByLabel("Password")).toBeFocused();
  await expect(page.getByLabel("Email")).toHaveValue("owner@example.com");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(page).toHaveURL(/\/signin\?next=/);
});

test("?method=password opens on the password form", async ({ page }) => {
  await page.goto("/signin?method=password");
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("link", { name: "Email me a code instead" })).toBeVisible();
});
