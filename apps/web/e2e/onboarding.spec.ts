import { createHmac } from "node:crypto";
import { test, expect } from "./fixtures/test";
import { admin, signIn, todayUtc } from "./fixtures/account";

/**
 * The whole first session, on fixtures: a new account is sent to the wizard,
 * the one screen shows what was read with the two lists that feed keywords
 * open, the button saves it all and runs the pipeline, and the plan it
 * produces is the one the calendar then shows.
 */
test("a new account is walked from /dashboard to five qualified topics and one draft", async ({ page, account }) => {
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

  // --- One screen: what was read, with the two lists that feed keywords open --
  //
  // Five steps until 2026-09-11. What a person actually needs to look at
  // before money is spent is the offerings and the competitors - both seed
  // keyword research, and both are what the model gets wrong most - so those
  // are open. Business, audiences and the blog are collapsed to one line each
  // and open on a click. Article settings live in Settings with their
  // defaults; the question about the person moved to the trial ask.
  await expect(page.getByRole("heading", { name: "Check what we found" })).toBeVisible();
  await expect(page.getByText("Based on your website, we've filled this in.", { exact: false })).toBeVisible();

  // Open by default: the two lists that seed keyword research.
  await expect(page.getByText("slow travel itineraries italy")).toBeVisible();
  await expect(page.getByText("tripcraft.example")).toBeVisible();

  // Collapsed to a line, and the line carries the content rather than a tick:
  // a wrong description has to be glanceable, not hidden behind "ready".
  const business = page.locator("details", { has: page.getByRole("heading", { name: "About your business" }) });
  await expect(business).toContainText("Nomad Atlas");
  await business.locator(":scope > summary").click();
  await expect(page.getByLabel("Business name")).toHaveValue("Nomad Atlas");
  await expect(page.getByLabel("Language")).toHaveValue("Italian");
  await expect(page.getByLabel(/^Market/)).toHaveValue("Italy");

  const audiences = page.locator("details", { has: page.getByRole("heading", { name: "Target audiences" }) });
  await expect(audiences).toContainText("Independent travel planners in Italy");

  // The sitemap and blog were found, not guessed, and the line says so.
  const blog = page.locator("details", { has: page.getByRole("heading", { name: "Where your content lives" }) });
  await expect(blog).toContainText("Found");
  await blog.locator("summary").click();
  const sitemapUrl = `https://${ws.domain}/sitemap.xml`;
  await expect(page.getByLabel(/^Sitemap/)).toHaveValue(sitemapUrl);
  await expect(page.getByLabel(/^Blog address/)).toHaveValue(`https://${ws.domain}/blog/`);

  // One button. It saves everything on the screen, marks the wizard done and
  // starts the run; there is no Back and no Skip, because there is nowhere to
  // go back to and nothing left worth skipping.
  await page.getByRole("button", { name: "Plan my first articles" }).click();

  // --- The run ---------------------------------------------------------------
  await expect(page.getByRole("heading", { name: "Finding your first article ideas" })).toBeVisible();

  // --- Everything on the screen is on disk -------------------------------------
  // Read after the run heading: the finish awaits its saves before it starts
  // the run, so this heading is the wait. Reading straight after the click
  // raced the write and read the row before it was there.
  const { data: afterProfile } = await db
    .from("workspaces")
    .select("name, language, location_code, business_profile, sitemap_url, blog_root_url")
    .eq("id", ws.id)
    .single();
  expect(afterProfile?.name).toBe("Nomad Atlas");
  // Labels on screen, codes in the columns: Italian/Italy -> it/2380.
  expect(afterProfile?.language).toBe("it");
  expect(afterProfile?.location_code).toBe(2380);
  expect((afterProfile?.business_profile as { name: string }).name).toBe("Nomad Atlas");
  expect(afterProfile?.sitemap_url).toBe(sitemapUrl);
  expect(afterProfile?.blog_root_url).toBe(`https://${ws.domain}/blog/`);
  await expect(page.getByRole("heading", { name: "Choose your first article" })).toBeVisible({ timeout: 30_000 });
  const {count: planned} = await db.from("calendar_entries").select("id",{count:"exact",head:true}).eq("workspace_id",ws.id);
  expect(planned).toBeGreaterThan(0);
  expect(planned).toBeLessThanOrEqual(5);
  const { data: beforeChoice } = await db.from("articles").select("id").eq("workspace_id", ws.id);
  expect(beforeChoice).toHaveLength(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Choose your first article" })).toBeVisible();
  await page.screenshot({path:test.info().outputPath("topic-choice.png"),fullPage:true});
  await page.getByRole("button", { name: "Write this article" }).first().click();
  // Worded from the run's own outcome since #P0-O2: the old fixed sentence was
  // printed whether or not anything reached the calendar.
  await expect(
    page.getByText(/Done\. \d+ articles? on the calendar and your first draft is in review\./),
  ).toBeVisible({ timeout: 30_000 });

  const { data: wsDone } = await db.from("workspaces").select("onboarded_at, onboarding_skipped_at").eq("id", ws.id).single();
  expect(wsDone?.onboarded_at).not.toBeNull();
  expect(wsDone?.onboarding_skipped_at).toBeNull();
  // Not asserted here any more: where the person heard of us is asked on the
  // trial screen, one optional click, and that screen only renders for an
  // account that can trial - the e2e server has no Stripe key, so it never
  // does. The picker itself is covered where it lives.

  const { data: entries } = await db
    .from("calendar_entries")
    .select("keyword, scheduled_date, status, article_id")
    .eq("workspace_id", ws.id)
    .order("scheduled_date", { ascending: true });
  expect(entries?.length).toBe(planned);

  // The first draft: written for day one of the plan, waiting in review.
  //
  // Onboarding writes exactly one preview; the rest waits for review/trial.
  const { data: articles } = await db.from("articles").select("id, title, status, keyword, generated_autonomously").eq("workspace_id", ws.id);
  expect(articles).toHaveLength(1);
  // Everything onboarding writes is autonomous and waits for a yes; the gate
  // is the product, so no draft may arrive in any other state.
  for (const a of articles!) {
    expect(a.status).toBe("review");
    expect(a.generated_autonomously).toBe(true);
  }
  const first = entries![0];
  expect(first.scheduled_date).toBe(todayUtc());
  expect(first.status).toBe("scheduled");
  expect(first.article_id).not.toBeNull();
  const dayOneArticle = articles!.find((a) => a.id === first.article_id);
  expect(dayOneArticle, "day one's calendar entry points at an article that exists").toBeTruthy();
  expect(dayOneArticle!.keyword).toBe(first.keyword);

  // --- The plan, on the calendar ------------------------------------------------
  if (process.env.E2E_BILLING === "1") await page.getByRole("link", { name: `${dayOneArticle!.title} · Read draft`, exact: true }).click();
  else await page.getByRole("button", { name: "Read my first draft" }).click();
  await expect(page).toHaveURL(/\/onboarding\/draft\//);
  await expect(page.locator("article")).toBeVisible();
  await expect(page.getByRole("region", { name: "Draft checks" })).toBeVisible();
  await page.screenshot({path:test.info().outputPath("first-draft-preview.png"),fullPage:true});
  // A partly unavailable source check must remain visible after persistence.
  const {data: savedDraft}=await db.from("articles").select("research").eq("workspace_id",ws.id).eq("id",dayOneArticle!.id).single();
  await db.from("articles").update({research:{...savedDraft?.research,editorialReview:{status:"unavailable",headline:"preserved",productClaims:"needs-review",qualitativeClaims:"not-checked",structure:"no-issues-detected",claimVerification:{status:"partial"},findings:[{category:"product",text:"Every plan supports unlimited sites.",reason:"The source limits this feature to one plan.",removed:false}]}}}).eq("workspace_id",ws.id).eq("id",dayOneArticle!.id);
  await page.reload();
  await expect(page.getByText("Some source checks could not finish.",{exact:false})).toBeVisible();
  await expect(page.getByText("Every plan supports unlimited sites.",{exact:true})).toBeVisible();
  if (process.env.E2E_BILLING === "1") {
    await page.getByRole("link", {name:"See your trial plan"}).click();
    await expect(page).toHaveURL(/#trial-plan$/);
    await expect(page.locator("#trial-plan")).toBeInViewport();
    await expect(page.getByRole("region", { name: "Continue with your draft" })).toContainText("100 articles per calendar month");
    await expect(page.getByRole("region", { name: "Continue with your draft" })).toContainText("99 available after activation");
    await page.screenshot({path:test.info().outputPath("draft-and-trial-gate.png"),fullPage:true});
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/onboarding/);
    // Real signed webhook and persisted entitlement; Stripe card entry itself
    // is covered by the separate hosted sandbox run, not mocked as a payment.
    const timestamp = Math.floor(Date.now() / 1000);
    const event = JSON.stringify({ id: `evt_fixture_${ws.id}`, type: "customer.subscription.created", created: timestamp,
      data: { object: { id: `sub_fixture_${ws.id}`, customer: `cus_fixture_${ws.id}`, status: "trialing", trial_end: timestamp + 7 * 86400,
        metadata: { account_id: account.accountId, plan: "starter" }, items: { data: [{ price: { id: "price_fixture_managed" } }] } } } });
    const signature = createHmac("sha256", "whsec_fixture_only").update(`${timestamp}.${event}`).digest("hex");
    const headers = { "content-type": "application/json", "stripe-signature": `t=${timestamp},v1=${signature}` };
    const activated = await page.request.post("/api/webhooks/stripe", { headers, data: event });
    expect(activated.ok()).toBeTruthy();
    expect((await page.request.post("/api/webhooks/stripe", { headers, data: event })).ok()).toBeTruthy();
    await expect.poll(async () => (await db.from("first_month_runs").select("status").eq("workspace_id", ws.id).single()).data?.status, { timeout: 45000 }).toBe("ready");
    const runs = await db.from("first_month_runs").select("workspace_id").eq("workspace_id", ws.id);
    expect(runs.data).toHaveLength(1);
    const prepared = await db.from("articles").select("id, status").eq("workspace_id", ws.id);
    expect(prepared.data!.length).toBeGreaterThan(1);
    expect(prepared.data!.every(article => article.status === "review")).toBe(true);
    expect(prepared.data!.filter(article => article.id === dayOneArticle!.id)).toHaveLength(1);
  }
  await page.goto("/dashboard");
  const month = page.getByRole("region", { name: "Your first month" });
  await expect(month.getByRole("link", { name: "Review and edit your first draft" })).toHaveAttribute("href", `/content/${dayOneArticle!.id}`);
  await page.reload();
  await expect(month).toContainText(dayOneArticle!.title);
  await page.screenshot({path:test.info().outputPath("first-dashboard.png"),fullPage:true});
  await expect(page.getByRole("region", { name: "Recommended actions" })).not.toContainText("Nothing is scheduled");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(month.getByRole("link", { name: "Review and edit your first draft" })).toBeVisible();
  await expect.poll(async()=>{
    const sidebar=await page.locator("#dashboard-sidebar").boundingBox();
    return sidebar ? sidebar.x+sidebar.width : 0;
  }).toBeLessThanOrEqual(1);
  await page.screenshot({path:test.info().outputPath("first-dashboard-mobile.png"),fullPage:true});
  await month.getByRole("link", { name: "Review and edit your first draft" }).click();
  await expect(page).toHaveURL(new RegExp(`/content/${dayOneArticle!.id}$`));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/content");

  const now = new Date();
  const thisMonth = entries!.filter((e) => {
    const d = new Date(e.scheduled_date as string);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  });
  expect(thisMonth.length).toBeGreaterThan(0);
  for (const e of thisMonth) {
    await expect(page.getByText(e.keyword as string, { exact: true })).toBeVisible();
  }
  // Day one carries the draft: on its planned day, and the card reads the
  // article's state - in review, with the draft one click away - rather than
  // the entry's (lib/plan/card-state.ts).
  const dayOne = page.locator("div.text-xs", { has: page.getByText(first.keyword as string, { exact: true }) }).first();
  await expect(dayOne).toContainText("In review");
  // Day one's own article, not `articles[0]`: the select is unordered and the
  // free week's fan-out puts six siblings beside it.
  await expect(dayOne.getByRole("link", { name: "Open draft" })).toHaveAttribute("href", `/content/${first.article_id}`);
});
