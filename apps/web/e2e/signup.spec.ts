import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { admin, uniqueTag } from "./fixtures/account";

/**
 * Without a workspace there is nothing to onboard, so signup refuses a bad
 * domain before it creates anything. Asserted on the database, not just the
 * screen: no agency and no auth user for this attempt.
 *
 * The password field is filled with random bytes generated here and discarded;
 * the form cannot be submitted without one, and the server rejects the domain
 * before it ever reads it.
 */
test("signup refuses an invalid domain and creates no account", async ({ page }) => {
  const tag = uniqueTag();
  const name = `E2E Signup ${tag}`;
  const email = `e2e+signup-${tag}@altorank.test`;

  await page.goto("/signup");
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();

  await page.locator('input[name="name"]').fill(name);
  await page.locator('input[name="domain"]').fill("not a domain");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(randomBytes(18).toString("base64url"));
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page).toHaveURL(/\/signup\?error=/);
  await expect(page.getByText("Enter your website as a domain, like acme.com.")).toBeVisible();
  await expect(page.getByText("Check your email", { exact: false })).toHaveCount(0);

  const db = admin();
  const { count } = await db.from("agencies").select("id", { count: "exact", head: true }).eq("name", name);
  expect(count).toBe(0);
  const { data: users } = await db.auth.admin.listUsers({ perPage: 1000 });
  expect(users?.users.some((u) => u.email === email)).toBe(false);
});
