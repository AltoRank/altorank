import { test, expect } from "./fixtures/test";

/**
 * Rule 2 of the wizard: never claim what did not happen. A site nothing could
 * be read from gets the failure, the reason and a retry - not empty fields
 * under "we've filled this in".
 */
test.use({ accountShape: { workspaces: [{ domain: "unreadable.e2e.altorank.test" }] } });

test("an unreadable site is reported as one, with a retry", async ({ page, signedIn }) => {
  const domain = signedIn.workspaces[0].domain;
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByRole("heading", { name: "About your business" })).toBeVisible();

  await expect(page.getByText(`We could not fill this in from ${domain}.`)).toBeVisible();
  await expect(page.getByText("We could not read enough of this site to describe it.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();

  await expect(page.getByText("we've filled this in", { exact: false })).toHaveCount(0);
  await expect(page.getByLabel("Business name")).toHaveValue("");
  await expect(page.getByLabel(/^Description/)).toHaveValue("");
});
