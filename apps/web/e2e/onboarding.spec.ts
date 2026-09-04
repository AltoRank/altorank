import { test, expect } from "./fixtures/test";
import { admin, signIn, todayUtc } from "./fixtures/account";

/**
 * The whole first session, on fixtures: a new account is sent to the wizard,
 * every screen persists what it shows, finishing runs the pipeline, and the
 * plan it produces is the one the calendar then shows.
 */
test("a new account is walked from /dashboard to a planned first month", async ({ page, account }) => {
  const ws = account.workspaces[0];
  const db = admin();

  // Hold the first server action (proposeProfile) for a moment. On fixtures it
  // answers in milliseconds, which would make the reading state a blink. The
  // handler stays registered and passes everything else straight through:
  // unrouting while the held request is still in flight aborts it.
  let held = false;
  await page.route("**/onboarding", async (route) => {
    if (route.request().method() === "POST" && !held) {
      held = true;
      await new Promise((r) => setTimeout(r, 1500));
    }
    await route.continue();
  });

  await signIn(page, account.email);
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByText(`Reading ${ws.domain}…`)).toBeVisible();

  // --- Step 1: the proposal, filled from the (stubbed) site ---------------
  await expect(page.getByRole("heading", { name: "About your business" })).toBeVisible();
  await expect(page.getByText("Based on your website, we've filled this in.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Business name")).toHaveValue("Nomad Atlas");
  await expect(page.getByLabel("Language")).toHaveValue("Italian");
  await expect(page.getByLabel(/^Market/)).toHaveValue("Italy");
  await page.getByRole("button", { name: "Continue" }).click();

  // --- Step 2: audiences and competitors, and step 1 is on disk -------------
  await expect(page.getByRole("heading", { name: "Who you sell to, and who you sell against" })).toBeVisible();
  await expect(page.getByText("Independent travel planners in Italy")).toBeVisible();
  await expect(page.getByText("tripcraft.example")).toBeVisible();
  const { data: afterProfile } = await db
    .from("workspaces")
    .select("name, language, location_code, business_profile")
    .eq("id", ws.id)
    .single();
  expect(afterProfile?.name).toBe("Nomad Atlas");
  // Labels on screen, codes in the columns: Italian/Italy -> it/2380.
  expect(afterProfile?.language).toBe("it");
  expect(afterProfile?.location_code).toBe(2380);
  expect((afterProfile?.business_profile as { name: string }).name).toBe("Nomad Atlas");
  await page.getByRole("button", { name: "Continue" }).click();

  // --- Step 3: the sitemap and blog were found, not guessed ------------------
  await expect(page.getByRole("heading", { name: "Where your content lives" })).toBeVisible();
  await expect(page.getByText("We found these on your site.", { exact: false })).toBeVisible();
  const sitemapUrl = `https://${ws.domain}/sitemap.xml`;
  await expect(page.getByLabel(/^Sitemap/)).toHaveValue(sitemapUrl);
  await expect(page.getByLabel(/^Blog address/)).toHaveValue(`https://${ws.domain}/blog/`);
  await page.getByRole("button", { name: "Continue" }).click();

  // --- Step 4: output settings -----------------------------------------------
  await expect(page.getByRole("heading", { name: "How your articles should read" })).toBeVisible();
  const { data: afterSite } = await db.from("workspaces").select("sitemap_url, blog_root_url").eq("id", ws.id).single();
  expect(afterSite?.sitemap_url).toBe(sitemapUrl);
  expect(afterSite?.blog_root_url).toBe(`https://${ws.domain}/blog/`);
  await page.getByLabel(/^Tone/).selectOption("friendly");
  await page.getByRole("button", { name: "Continue" }).click();

  // --- Step 5: destinations, and step 4 is on disk ---------------------------
  await expect(page.getByRole("heading", { name: "Where should we publish?" })).toBeVisible();
  const { data: output } = await db
    .from("workspace_output_settings")
    .select("tone, internal_links")
    .eq("workspace_id", ws.id)
    .maybeSingle();
  expect(output?.tone).toBe("friendly");
  expect(output?.internal_links).toBe(3);

  await page.getByRole("button", { name: "Finish and plan my first month" }).click();

  // --- The run ---------------------------------------------------------------
  await expect(page.getByRole("heading", { name: "Creating your content plan" })).toBeVisible();
  const plannedLine = page.getByText(/Planned \d+ articles? over the next 30 days/);
  await expect(plannedLine).toBeVisible({ timeout: 30_000 });
  const planned = Number((await plannedLine.textContent())?.match(/Planned (\d+)/)?.[1]);
  expect(planned).toBeGreaterThan(0);
  await expect(page.getByText("Done. Your first month is on the calendar.")).toBeVisible({ timeout: 30_000 });

  const { data: wsDone } = await db.from("workspaces").select("onboarded_at, onboarding_skipped_at").eq("id", ws.id).single();
  expect(wsDone?.onboarded_at).not.toBeNull();
  expect(wsDone?.onboarding_skipped_at).toBeNull();

  const { data: entries } = await db
    .from("calendar_entries")
    .select("keyword, scheduled_date, status, article_id")
    .eq("workspace_id", ws.id)
    .order("scheduled_date", { ascending: true });
  expect(entries?.length).toBe(planned);

  // The first draft: written for day one of the plan, waiting in review.
  const { data: articles } = await db.from("articles").select("id, status, keyword, generated_autonomously").eq("workspace_id", ws.id);
  expect(articles?.length).toBe(1);
  expect(articles?.[0].status).toBe("review");
  expect(articles?.[0].generated_autonomously).toBe(true);
  const first = entries![0];
  expect(first.scheduled_date).toBe(todayUtc());
  expect(first.keyword).toBe(articles?.[0].keyword);
  expect(first.article_id).toBe(articles?.[0].id);
  expect(first.status).toBe("scheduled");

  // --- The plan, on the calendar ------------------------------------------------
  await page.getByRole("button", { name: "Open my plan" }).click();
  await expect(page).toHaveURL(/\/content$/);

  const now = new Date();
  const thisMonth = entries!.filter((e) => {
    const d = new Date(e.scheduled_date as string);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  });
  expect(thisMonth.length).toBeGreaterThan(0);
  for (const e of thisMonth) {
    await expect(page.getByText(e.keyword as string, { exact: true })).toBeVisible();
  }
  // Day one carries the draft: on its planned day, marked scheduled, not
  // dropped because the article is still in review.
  const dayOne = page.locator("div.text-xs", { has: page.getByText(first.keyword as string, { exact: true }) }).first();
  await expect(dayOne).toContainText("Scheduled");
});
