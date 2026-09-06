import { test, expect } from "./fixtures/test";
import { admin, todayUtc } from "./fixtures/account";

/**
 * An agency is the account; a workspace is one site. RLS only enforces the
 * first, so a page that forgets its workspace still renders - with the other
 * site's rows mixed in. Two sites on one agency, and the calendar and keywords
 * pages must show only the site the switcher is on.
 */
test.use({ accountShape: { workspaces: [
    { domain: "alpha.e2e.altorank.test", onboarded: true },
    { domain: "beta.e2e.altorank.test", onboarded: true },
  ] } });

test("keywords and calendar show only the scoped workspace after switching", async ({ page, account }) => {
  const [alpha, beta] = account.workspaces;
  const db = admin();
  const tag = account.email.split("@")[0].replace("e2e+", "");
  const alphaTerm = `alpha keyword ${tag}`;
  const betaTerm = `beta keyword ${tag}`;
  const alphaPlan = `alpha plan ${tag}`;
  const betaPlan = `beta plan ${tag}`;

  // difficulty stays null: no provider has scored these.
  const { error: kwError } = await db.from("keywords").insert([
    { workspace_id: alpha.id, term: alphaTerm, volume: 0, difficulty: null, intent: "info", status: "new" },
    { workspace_id: beta.id, term: betaTerm, volume: 0, difficulty: null, intent: "info", status: "new" },
  ]);
  if (kwError) throw new Error(`seed keywords: ${kwError.message}`);
  const { error: calError } = await db.from("calendar_entries").insert([
    { workspace_id: alpha.id, keyword: alphaPlan, scheduled_date: todayUtc(), status: "queue" },
    { workspace_id: beta.id, keyword: betaPlan, scheduled_date: todayUtc(), status: "queue" },
  ]);
  if (calError) throw new Error(`seed calendar: ${calError.message}`);

  const { signIn } = await import("./fixtures/account");
  await signIn(page, account.email, "/keywords");
  await expect(page).toHaveURL(/\/keywords$/);

  // The switcher is a button naming the active site; it opens a listbox of sites.
  const switcher = page.getByRole("button", { name: "Choose which site to view" });
  async function switchTo(domain: string) {
    await switcher.click();
    await page.getByRole("listbox", { name: "Sites" }).getByRole("option", { name: domain }).click();
  }

  // No cookie yet: the oldest workspace (alpha) is the scope.
  await expect(switcher).toContainText(alpha.domain);
  await expect(page.getByText(alphaTerm, { exact: true })).toBeVisible();
  await expect(page.getByText(betaTerm, { exact: true })).toHaveCount(0);

  await switchTo(beta.domain);
  await expect(page.getByText(betaTerm, { exact: true })).toBeVisible();
  await expect(page.getByText(alphaTerm, { exact: true })).toHaveCount(0);

  // The scope is a cookie, so it follows into the calendar.
  await page.goto("/content");
  await expect(switcher).toContainText(beta.domain);
  await expect(page.getByText(betaPlan, { exact: true })).toBeVisible();
  await expect(page.getByText(alphaPlan, { exact: true })).toHaveCount(0);

  await switchTo(alpha.domain);
  await expect(page.getByText(alphaPlan, { exact: true })).toBeVisible();
  await expect(page.getByText(betaPlan, { exact: true })).toHaveCount(0);
});
