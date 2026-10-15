import { test, expect } from "@playwright/test";
import { admin, uniqueTag } from "./fixtures/account";

/**
 * Signup asks one question at a time: the website, then the email, then a
 * code typed on /signup/verify. Without a workspace there is nothing to
 * onboard, so a bad domain is refused before anything is created. Asserted on
 * the database, not just the screen.
 */
test("signup refuses an invalid domain at the first step and creates no account", async ({ page }) => {
  await page.goto("/signup");
  await expect(page.getByRole("heading", { name: /Read your first article before you start a trial/ })).toBeVisible();

  await page.getByLabel("Your website").fill("not a domain");
  await page.getByRole("button", { name: "Continue" }).click();

  // Refused on the page: the email step never opens, and no password is asked.
  await expect(page.getByText("Enter your website as a domain, like acme.com.")).toBeVisible();
  await expect(page.locator('input[name="email"]')).toHaveCount(0);
  await expect(page.locator('input[name="password"]')).toHaveCount(0);

  const { count } = await admin().from("workspaces").select("id", { count: "exact", head: true }).eq("domain", "not a domain");
  expect(count).toBe(0);
});

test("a good domain moves on to the email, with the domain kept and changeable", async ({ page }) => {
  const domain = `acme-${uniqueTag()}.altorank.test`;
  await page.goto("/signup");
  await page.getByLabel("Your website").fill(`https://www.${domain}/pricing`);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("Work email")).toBeFocused();
  await expect(page.locator('input[type="hidden"][name="domain"]')).toHaveValue(domain);
  await expect(page.getByRole("button", { name: "Send my code" })).toBeVisible();
  await page.getByRole("button", { name: "Change" }).click();
  await expect(page.getByLabel("Your website")).toHaveValue(domain);
});

/**
 * The marketing site adds where a visitor came from to the signup link
 * (`src`, `ref`, `utm_*`; lib/auth/signup-source.ts). The domain step is also
 * checked on the server: a native submit (what a press before hydration does)
 * skips the page's own check, and the server refuses a bad domain and lands
 * back on a URL that still carries the source, so the next submit records it.
 */
test.describe("the server checks the domain step too", () => {
  const submitNatively = (page: import("@playwright/test").Page) =>
    page.evaluate(() => (document.querySelector("form") as HTMLFormElement).requestSubmit());

  test("signup keeps the signup source through a refused submit", async ({ page }) => {
    await page.goto("/signup?src=/pricing/&ref=news.ycombinator.com&utm_source=newsletter");
    await expect(page.locator('input[type="hidden"][name="src"]')).toHaveValue("/pricing/");

    await page.getByLabel("Your website").fill("not a domain");
    await submitNatively(page);

    await expect(page).toHaveURL(/\/signup\?error=.*&src=%2Fpricing%2F&ref=news\.ycombinator\.com&utm_source=newsletter$/);
    await expect(page.getByText("Enter your website as a domain, like acme.com.")).toBeVisible();
    await expect(page.locator('input[type="hidden"][name="src"]')).toHaveValue("/pricing/");
    await expect(page.locator('input[type="hidden"][name="ref"]')).toHaveValue("news.ycombinator.com");
    await expect(page.locator('input[type="hidden"][name="utm_source"]')).toHaveValue("newsletter");
  });

  test("a good domain comes back on the email step", async ({ page }) => {
    const domain = `acme-${uniqueTag()}.altorank.test`;
    await page.goto("/signup");
    await page.getByLabel("Your website").fill(domain);
    await submitNatively(page);
    await expect(page).toHaveURL(new RegExp(`/signup\\?domain=${domain.replace(/\./g, "\\.")}$`));
    await expect(page.getByLabel("Work email")).toBeVisible();
  });
});
