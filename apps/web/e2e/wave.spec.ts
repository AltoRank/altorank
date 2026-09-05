import { test, expect } from "./fixtures/test";
import { admin } from "./fixtures/account";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FREE_TIER_PACE, monthlyFromPace } from "@/lib/content/pace";
import { API_KEY_PREFIX, DISPLAY_PREFIX_LENGTH } from "@/lib/agent/api-keys";
import { STUB_KEYWORDS } from "@/lib/e2e/stubs";

/**
 * The 2026-09-04 wave, through the UI, on fixtures: the planner card's hover
 * row, the Articles-plan control, the research drawer, the honest blockers on
 * /improvements, API keys shown once, the linking page's empty state, the
 * theme toggle and the share card. Every assertion is on visible text or on a
 * row the action wrote; none is on a number the product did not measure.
 */
test.use({ accountShape: { workspaces: [{ domain: "wave.e2e.altorank.test", onboarded: true }] } });

/** buildPlan's horizon (lib/onboarding/plan.ts PLAN_HORIZON_DAYS), copied so the spec does not import the planner's model calls. */
const PLAN_HORIZON_DAYS = 30;

/** The same eight terms the analysis stub writes, inserted directly: the plan needs keywords to plan. */
async function seedKeywords(db: SupabaseClient, workspaceId: string): Promise<void> {
  const { error } = await db.from("keywords").insert(
    STUB_KEYWORDS.map((k) => ({
      workspace_id: workspaceId,
      term: k.term,
      volume: k.volume,
      difficulty: k.difficulty,
      intent: k.intent,
      status: "new",
      source: "ideas",
    })),
  );
  if (error) throw new Error(`seed keywords: ${error.message}`);
}

/** Planned, unwritten entries: what the popover calls "planned" and the cap counts. */
async function plannedCount(db: SupabaseClient, workspaceId: string): Promise<number> {
  const { count, error } = await db
    .from("calendar_entries")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("status", "queue")
    .is("article_id", null);
  if (error) throw new Error(`count entries: ${error.message}`);
  return count ?? 0;
}

/** "Plan the month" on /content and wait until the header reports the plan. */
async function planTheMonth(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/content");
  await page.getByRole("button", { name: "Plan the month" }).click();
  await expect(page.getByText(/[1-9]\d* of 60 scheduled/)).toBeVisible();
}

test("a planned card offers Instructions, Questions, Move and Remove; Remove drops the entry and keeps the keyword", async ({ page, signedIn }) => {
  const ws = signedIn.workspaces[0];
  const db = admin();
  await seedKeywords(db, ws.id);
  await planTheMonth(page);

  const { data: entries } = await db
    .from("calendar_entries")
    .select("id, keyword, keyword_id, scheduled_date")
    .eq("workspace_id", ws.id)
    .order("scheduled_date", { ascending: true });
  expect(entries?.length).toBeGreaterThan(0);
  // The first entry lands on today, so it is on this month's grid whatever the date.
  const first = entries![0];

  const card = page.locator("div.group", { has: page.getByText(first.keyword as string, { exact: true }) }).first();
  await expect(card).toBeVisible();
  await expect(card.getByText("Planned")).toBeVisible();
  await card.hover();
  for (const title of ["Instructions", "Questions", "Move to another day", "Remove from plan"]) {
    await expect(card.getByTitle(title)).toBeVisible();
    await expect(card.getByTitle(title)).toBeEnabled();
  }

  await card.getByTitle("Remove from plan").click();
  const dialog = page.getByRole("dialog", { name: "Remove from plan" });
  await expect(dialog.getByText("the keyword itself stays tracked", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "Remove", exact: true }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(first.keyword as string, { exact: true })).toHaveCount(0);

  // The entry is gone; the keyword row is not, and it is marked so the planner leaves it alone.
  const { count: entryLeft } = await db.from("calendar_entries").select("id", { count: "exact", head: true }).eq("id", first.id);
  expect(entryLeft).toBe(0);
  expect(await plannedCount(db, ws.id)).toBe(entries!.length - 1);
  const { data: keyword } = await db.from("keywords").select("id, term, plan_excluded_at").eq("id", first.keyword_id).single();
  expect(keyword?.term).toBe(first.keyword);
  expect(keyword?.plan_excluded_at).not.toBeNull();
});

test("the Articles-plan popover lists the paces; 1 -> 3 a week re-plans, and back", async ({ page, signedIn }) => {
  const ws = signedIn.workspaces[0];
  const db = admin();
  await seedKeywords(db, ws.id);
  await planTheMonth(page);

  // Top-up mode fills to the monthly figure the pace quotes, one per plan day at most.
  const atFreePace = Math.min(monthlyFromPace(FREE_TIER_PACE), Math.ceil((FREE_TIER_PACE * PLAN_HORIZON_DAYS) / 7));
  expect(await plannedCount(db, ws.id)).toBe(atFreePace);

  const trigger = page.getByRole("button", { name: /^Articles plan/ });
  await expect(trigger).toHaveText(/Articles plan: 1 a week/);
  await trigger.click();
  const popover = page.getByRole("dialog", { name: "Articles plan" });
  await expect(popover.getByText("Current plan")).toBeVisible();
  await expect(popover.getByText(`1 a week · ${atFreePace} of 60 planned`)).toBeVisible();

  // Every pace is offered as a choice: self-host is unmetered, so none says "Needs the … plan".
  const paces = ["1 a week", "2 a week", "3 a week", "5 a week", "one a day", "two a day", "three a day"];
  for (const label of paces) {
    await expect(popover.getByRole("button", { name: new RegExp(`^${label}\\b`) })).toBeVisible();
  }
  await expect(popover.getByText(/Needs the .* plan/)).toHaveCount(0);
  await expect(popover.getByRole("button", { name: /^1 a week\b/ })).toHaveAttribute("aria-pressed", "true");

  // 1 -> 3 a week. The re-plan is a replace: 13 slots over 30 days, and eight keywords to fill them.
  await popover.getByRole("button", { name: /^3 a week\b/ }).click();
  await expect(popover.getByRole("button", { name: /^3 a week\b/ })).toHaveAttribute("aria-pressed", "true");
  const apply = popover.getByRole("button", { name: "Apply" });
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(page.getByText(/^3 a week.*planned\.$/)).toBeVisible();
  await expect(popover).toHaveCount(0);

  const atThree = Math.min(STUB_KEYWORDS.length, Math.ceil((3 * PLAN_HORIZON_DAYS) / 7));
  await expect.poll(() => plannedCount(db, ws.id)).toBe(atThree);
  const { data: wsAfter } = await db.from("workspaces").select("auto_generate_weekly_limit").eq("id", ws.id).single();
  expect(wsAfter?.auto_generate_weekly_limit).toBe(3);
  await expect(trigger).toHaveText(/Articles plan: 3 a week/);

  // And back to 1: a replace at the free pace lays out one a week over the horizon.
  await trigger.click();
  await popover.getByRole("button", { name: /^1 a week\b/ }).click();
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(page.getByText(/^1 a week.*planned\.$/)).toBeVisible();

  const atOne = Math.ceil((1 * PLAN_HORIZON_DAYS) / 7);
  await expect.poll(() => plannedCount(db, ws.id)).toBe(atOne);
  const { data: wsBack } = await db.from("workspaces").select("auto_generate_weekly_limit").eq("id", ws.id).single();
  expect(wsBack?.auto_generate_weekly_limit).toBe(1);
  await expect(trigger).toHaveText(/Articles plan: 1 a week/);
});

test("the research drawer opens with four tabs and an honest empty Stored tab", async ({ page, signedIn }) => {
  await page.goto("/keywords");
  await page.getByRole("button", { name: "Research keywords" }).click();

  const drawer = page.getByRole("dialog", { name: "Research keywords" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText(signedIn.workspaces[0].domain, { exact: false }).first()).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Generate", exact: true })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Add", exact: true })).toBeVisible();
  await expect(drawer.getByRole("button", { name: /^Stored/ })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Chat", exact: true })).toBeVisible();

  await drawer.getByRole("button", { name: /^Stored/ }).click();
  await expect(drawer.getByText("Keywords you researched earlier but did not schedule.")).toBeVisible();
  await expect(drawer.getByText("No stored keywords yet.")).toBeVisible();
});

test("/improvements names the three things that block it for a site without Search Console or a CMS", async ({ page, signedIn }) => {
  await page.goto("/improvements");
  await expect(page.getByRole("heading", { name: "Improvements" })).toBeVisible();
  // The page head names the site; the sidebar switcher names it too, so scope to the page.
  await expect(page.getByRole("main").getByText(signedIn.workspaces[0].domain, { exact: true })).toBeVisible();

  await expect(page.getByText("Search Console is not connected", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Connect Search Console" })).toBeVisible();
  await expect(page.getByText("No CMS connected", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Connect a CMS" })).toBeVisible();
  await expect(page.getByText("Scheduled rewrites are off for this site", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open settings" })).toBeVisible();

  // Nothing to analyse without Search Console, and the button says so rather than pretending.
  await expect(page.getByRole("button", { name: "Analyze now" })).toBeDisabled();
});

test("an API key is shown once on creation and can be revoked", async ({ page, signedIn }) => {
  const db = admin();
  const name = `Wave agent ${signedIn.email.split("@")[0].replace("e2e+", "")}`;

  await page.goto("/settings/api-keys");
  await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();
  await expect(page.getByText("No API keys yet.")).toBeVisible();

  await page.getByRole("button", { name: "Create API key" }).click();
  const create = page.getByRole("dialog", { name: "Create API key" });
  await expect(create.getByText("The full value will only be displayed once.", { exact: false })).toBeVisible();
  await create.getByLabel("Name").fill(name);
  await create.getByRole("button", { name: "Create key" }).click();

  // The shown-once dialog: the full key, and the warning that it will not come back.
  const shown = page.getByRole("dialog", { name: "API key created" });
  await expect(shown).toBeVisible();
  await expect(shown.getByText(`“${name}” is ready.`)).toBeVisible();
  await expect(shown.getByText("It will not be shown again.", { exact: false })).toBeVisible();
  const key = ((await shown.locator("code").first().textContent()) ?? "").trim();
  expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
  await expect(shown.getByText(`export ALTORANK_API_KEY=${key}`)).toBeVisible();

  const { data: rows } = await db
    .from("api_keys")
    .select("id, name, prefix, key_hash, revoked_at, created_by")
    .eq("agency_id", signedIn.agencyId);
  expect(rows?.length).toBe(1);
  const row = rows![0];
  expect(row.name).toBe(name);
  expect(row.prefix).toBe(key.slice(0, DISPLAY_PREFIX_LENGTH));
  // The row keeps a hash, never the key.
  expect(row.key_hash).not.toBe(key);
  expect(row.revoked_at).toBeNull();
  expect(row.created_by).toBe(signedIn.userId);

  await shown.getByRole("button", { name: "Done" }).click();
  await expect(shown).toHaveCount(0);
  await expect(page.getByText(key)).toHaveCount(0);
  const tableRow = page.locator("tr", { has: page.getByText(name, { exact: true }) });
  await expect(tableRow.getByText("Active")).toBeVisible();
  await expect(tableRow.getByText(`${row.prefix}…`)).toBeVisible();

  await tableRow.getByRole("button", { name: "Revoke" }).click();
  const revoke = page.getByRole("dialog", { name: "Revoke API key" });
  await expect(revoke.getByText("This cannot be undone.", { exact: false })).toBeVisible();
  await revoke.getByRole("button", { name: "Revoke key" }).click();
  await expect(revoke).toHaveCount(0);

  await expect(tableRow.getByText("Revoked")).toBeVisible();
  await expect(tableRow.getByRole("button", { name: "Revoke" })).toHaveCount(0);
  const { data: after } = await db.from("api_keys").select("revoked_at").eq("id", row.id).single();
  expect(after?.revoked_at).not.toBeNull();
});

test("/linking offers Detect links and says what an empty result is", async ({ page, signedIn }) => {
  await page.goto("/linking");
  await expect(page.getByRole("heading", { name: "Linking configuration" })).toBeVisible();
  // The page head names the site; the sidebar switcher names it too, so scope to the page.
  await expect(page.getByRole("main").getByText(signedIn.workspaces[0].domain, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Detect links" })).toBeVisible();
  // No sitemap or blog root was saved for this site, so there is nothing to read yet.
  await expect(page.getByText("No sources yet.", { exact: false })).toBeVisible();
  await expect(page.getByText("Run a link detection to see the result.")).toBeVisible();
});

test("the theme toggle flips data-theme and the choice survives a reload", async ({ page, signedIn }) => {
  // Signed in and on /dashboard: the toggle lives in the sidebar footer.
  await expect(page).toHaveURL(/\/dashboard$/);
  void signedIn;
  const html = page.locator("html");
  // Playwright's Desktop Chrome prefers light, and nothing is stored yet.
  await expect(html).toHaveAttribute("data-theme", "light");

  const toggle = page.getByTestId("theme-toggle");
  await expect(toggle).toHaveAttribute("aria-label", "Switch to dark");
  await toggle.click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(toggle).toHaveAttribute("aria-label", "Switch to light");

  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(page.getByTestId("theme-toggle")).toHaveAttribute("aria-label", "Switch to light");

  await page.getByTestId("theme-toggle").click();
  await expect(html).toHaveAttribute("data-theme", "light");
});

test("Share results opens the card and leaves unmeasured figures off it", async ({ page, signedIn }) => {
  await page.getByRole("button", { name: "Share results" }).click();
  const dialog = page.getByRole("dialog", { name: "Share results" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Unmeasured figures are left off rather than shown as zero.", { exact: false })).toBeVisible();

  // Counts the product made are on the card; authority and clicks, never measured, are named as missing.
  await expect(dialog.getByText(signedIn.workspaces[0].domain, { exact: true }).first()).toBeVisible();
  await expect(dialog.getByText("Articles published", { exact: true }).first()).toBeVisible();
  await expect(dialog.getByText("Articles planned", { exact: true }).first()).toBeVisible();
  await expect(dialog.getByText("Authority", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("Search clicks, 28 days", { exact: true })).toHaveCount(0);
  await expect(
    dialog.getByText("Not on the card: authority (not measured yet); search clicks (Search Console not connected)."),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Copy image" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Download PNG" })).toBeVisible();
});
