import { test, expect } from "./fixtures/test";
import { admin } from "./fixtures/account";

/**
 * Settings > Emails: the opt-out that used to be reachable only from an email
 * footer.
 *
 * The assertions that matter are the two ends of it - the switch writes the
 * signed-in person's own `email_preferences` row, and the required categories
 * are named on the page rather than quietly missing. A list of switches that
 * omits the mail somebody actually receives is worse than no list.
 */

test("a member switches off one category, and it lands on their own row", async ({ page, signedIn }) => {
  const db = admin();

  await page.goto("/settings/emails");
  await expect(page.getByRole("heading", { name: "Emails" })).toBeVisible();

  // Nothing is off to begin with: no row, which reads as everything on.
  const drafts = page.getByRole("switch", { name: "Drafts and approvals" });
  await expect(drafts).toHaveAttribute("aria-checked", "true");

  await drafts.click();
  await expect(drafts).toHaveAttribute("aria-checked", "false");

  await expect
    .poll(async () => {
      const { data } = await db
        .from("email_preferences")
        .select("unsubscribed")
        .eq("email", signedIn.email.toLowerCase())
        .maybeSingle();
      return (data?.unsubscribed as string[] | null) ?? [];
    })
    .toContain("drafts");

  // And back, so the page is not a one-way door.
  await drafts.click();
  await expect(drafts).toHaveAttribute("aria-checked", "true");
  await expect
    .poll(async () => {
      const { data } = await db
        .from("email_preferences")
        .select("unsubscribed")
        .eq("email", signedIn.email.toLowerCase())
        .maybeSingle();
      return (data?.unsubscribed as string[] | null) ?? [];
    })
    .not.toContain("drafts");
});

test("the required categories are named, with no switch to turn them off", async ({ page, signedIn }) => {
  await page.goto("/settings/emails");
  await expect(page.getByText(signedIn.email)).toBeVisible();

  await expect(page.getByRole("switch", { name: "Billing" })).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "Account access" })).toHaveCount(0);

  const keep = page.getByText("These keep coming");
  await expect(keep).toBeVisible();
  await expect(page.getByText("a failed payment, a plan change", { exact: false })).toBeVisible();
});

test("turning everything off writes the pseudo-category, and one press undoes it", async ({ page, signedIn }) => {
  const db = admin();
  await page.goto("/settings/emails");

  await page.getByRole("button", { name: "Turn all of these off" }).click();
  await expect(page.getByRole("switch", { name: "Monthly reports" })).toHaveAttribute("aria-checked", "false");

  // Stored as `all` rather than expanded, so a category added later is off for
  // somebody who already said "stop all of it".
  await expect
    .poll(async () => {
      const { data } = await db
        .from("email_preferences")
        .select("unsubscribed")
        .eq("email", signedIn.email.toLowerCase())
        .maybeSingle();
      return (data?.unsubscribed as string[] | null) ?? [];
    })
    .toEqual(["all"]);

  await page.getByRole("button", { name: "Turn everything back on" }).click();
  await expect(page.getByRole("switch", { name: "Monthly reports" })).toHaveAttribute("aria-checked", "true");
});
