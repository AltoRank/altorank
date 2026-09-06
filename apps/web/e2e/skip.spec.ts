import { test, expect } from "./fixtures/test";
import { admin } from "./fixtures/account";

/**
 * Skipping is allowed on purpose, and it has to stick: the wizard is not a
 * wall. The one thing it still asks on the way out is where the person heard
 * of us - a click, then the dashboard.
 */
test("Skip setup records the skip and the dashboard stops redirecting", async ({ page, signedIn }) => {
  const ws = signedIn.workspaces[0];
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByRole("heading", { name: "About your business" })).toBeVisible();

  await page.getByRole("button", { name: "Skip setup" }).click();
  await expect(page.getByRole("heading", { name: "One thing before you go" })).toBeVisible();
  const finish = page.getByRole("button", { name: "Skip and finish" });
  await expect(finish).toBeDisabled();
  await page.getByRole("radio", { name: "Friend or colleague" }).click();
  await finish.click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("button", { name: "Choose which site to view" })).toBeVisible();

  const db = admin();
  const { data } = await db.from("workspaces").select("onboarded_at, onboarding_skipped_at").eq("id", ws.id).single();
  expect(data?.onboarding_skipped_at).not.toBeNull();
  expect(data?.onboarded_at).toBeNull();
  const { data: agency } = await db.from("agencies").select("attribution_source").eq("id", signedIn.agencyId).single();
  expect(agency?.attribution_source).toBe("friend");

  // A fresh load, not a client-side push: the layout's gate is what is tested.
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto("/content");
  await expect(page).toHaveURL(/\/content$/);
});
