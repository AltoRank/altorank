import { test, expect } from "./fixtures/test";

/**
 * Rule 2 of the wizard: never claim what did not happen. A site nothing could
 * be read from gets the failure, the reason and a retry - not empty fields
 * under "we've filled this in".
 */
test.use({ accountShape: { workspaces: [{ domain: "unreadable.e2e.altorank.test" }] } });

test("an unreadable site is reported as one, with a retry", async ({ page, signedIn }) => {
  void signedIn;
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByRole("heading", { name: "We couldn’t read your website" })).toBeVisible();

  await expect(page.getByText("Your site did not let us read it.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();

  // Only what a first article needs is asked; rivals and publishing wait for Settings.
  await expect(page.getByRole("heading", { name: "Who buys from you" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Where your content lives" })).toHaveCount(0);

  await expect(page.getByText("we've filled this in", { exact: false })).toHaveCount(0);
  const more = page.locator("details", { has: page.getByRole("heading", { name: "More about your business" }) });
  await more.locator(":scope > summary").click();
  await expect(page.getByLabel("Business name")).toHaveValue("");
  await expect(page.getByLabel(/^Description/)).toHaveValue("");
});
