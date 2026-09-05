import { test, expect } from "./fixtures/test";
import { admin } from "./fixtures/account";

/** Skipping is allowed on purpose, and it has to stick: the wizard is not a wall. */
test("Skip setup records the skip and the dashboard stops redirecting", async ({ page, signedIn }) => {
  const ws = signedIn.workspaces[0];
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByRole("heading", { name: "About your business" })).toBeVisible();

  await page.getByRole("button", { name: "Skip setup" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByLabel("Choose which workspace to view")).toBeVisible();

  const { data } = await admin().from("workspaces").select("onboarded_at, onboarding_skipped_at").eq("id", ws.id).single();
  expect(data?.onboarding_skipped_at).not.toBeNull();
  expect(data?.onboarded_at).toBeNull();

  // A fresh load, not a client-side push: the layout's gate is what is tested.
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto("/content");
  await expect(page).toHaveURL(/\/content$/);
});
