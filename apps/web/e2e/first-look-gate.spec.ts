import { test, expect } from "./fixtures/test";
import { admin, signIn } from "./fixtures/account";
import type { Page } from "@playwright/test";

/**
 * The first look's second half, in a real browser (UX audit 2026-10-12,
 * part B): the wait, the gate, the price, the exits.
 *
 * The e2e server has no Stripe key, so the trial gate is forced on with the
 * dev toolbar's simulation cookie (lib/dev/simulation.ts): the page renders
 * the gate exactly as a gated account sees it, while the run itself is the
 * stubbed pipeline (no provider is called). Markup-level checks are in
 * components/onboarding/__tests__ (gate-offer, gate-exits, gate-promises,
 * first-look-wait); these are the ones that need a browser.
 */

const SHOTS = process.env.E2E_SHOTS_DIR;

async function forceGate(page: Page) {
  await page.context().addCookies([
    { name: "dev_simulation", value: encodeURIComponent(JSON.stringify({ gate: true })), domain: "localhost", path: "/" },
  ]);
}

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

async function startSetup(page: Page) {
  await page.goto("/onboarding");
  await expect(page.getByRole("heading", { name: "Check what we found" })).toBeVisible();
  await page.getByRole("button", { name: /^(Write my first article|Plan my first articles)$/ }).click();
}

test("one clock to the gate, a price box that sells, a bar on the same plan, and a soft exit", async ({ page, signedIn }) => {
  await forceGate(page);
  await startSetup(page);

  // One estimate, said once: about 3 minutes in all - not "usually about 1:32".
  await expect(page.getByText("about 3 minutes in all")).toBeVisible();
  await expect(page.getByText(/usually about/)).toHaveCount(0);
  await shot(page, "b17-loading-1280");

  // The gate: the article, and under it the price box.
  await expect(page.getByRole("heading", { name: /Your first article is (written|being written)/ })).toBeVisible({ timeout: 45_000 });
  const box = page.locator("section", { has: page.getByRole("heading", { name: /Start your free 7-day trial/ }) });
  await expect(box).toContainText("Nothing publishes until you approve it");
  await expect(box.getByTestId("trial-charge-line")).toHaveText(/^€0 today, then €69\/month from [A-Z][a-z]+ \d{1,2}\.$/);
  await expect(box).toContainText("We email you 3 days before the trial ends");
  await expect(box).toContainText("Cancel in Settings › Billing before the trial ends and nothing is charged.");
  await expect(box).not.toContainText(/renewal/i);
  // The trial button is the full-width primary.
  const start = box.getByRole("button", { name: "Start 7-day trial" });
  const boxWidth = (await box.boundingBox())!.width;
  expect((await start.boundingBox())!.width).toBeGreaterThan(boxWidth - 60);

  // Yearly, quietly behind "Other plans", with its real saving; the bar then quotes the same plan.
  await box.getByText("Other plans", { exact: true }).click();
  await box.getByRole("button", { name: /Or pay yearly: €690\/year, two months free \(save €138\)/ }).click();
  await expect(box.getByTestId("trial-charge-line")).toHaveText(/^€0 today, then €690\/year from /);
  // Past the button, it off screen above: the bar, on the same plan. From lg
  // the rail beside the article holds the button and the bar is phone-only.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const bar = page.getByTestId("trial-bar");
  const narrow = page.viewportSize()!.width < 1024;
  if (narrow && (!(await start.isVisible()) || (await start.boundingBox())!.y + 20 < 0)) {
    await expect(bar).toBeVisible();
    await expect(bar).toContainText("7 days free, then €690/year");
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, "b17-gate-1280");

  // The soft exit, under the button: a link back by email, once.
  await page.evaluate(() => document.getElementById("start-trial")?.scrollIntoView({ block: "center" }));
  await page.getByRole("button", { name: "Not ready yet? Email me this article" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Sent to|could not be sent|turned off/ })).toBeVisible();

  // The setup log points nowhere a person before the trial cannot go.
  await expect(page.getByText(/from Keywords|see Keywords/)).toHaveCount(0);

  // The ledger holds one claim for this article and owner, no more.
  const { data: sent } = await admin().from("sent_emails").select("email_type, recipient").eq("email_type", "first_article_link").eq("recipient", signedIn.email.toLowerCase());
  expect((sent ?? []).length).toBeLessThanOrEqual(1);
});

test("with auto-start on, the run starts by itself and shows what it read beside it", async ({ page, signedIn }) => {
  void signedIn;
  await page.context().addCookies([
    { name: "dev_simulation", value: encodeURIComponent(JSON.stringify({ gate: true, autostart: true })), domain: "localhost", path: "/" },
  ]);
  await page.goto("/onboarding");
  // No check screen and no click: the loading screen, with the read beside it.
  await expect(page.getByText("about 3 minutes in all")).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("heading", { name: "Check what we found" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "What we understood" })).toBeVisible();
  await shot(page, "v2-build-1280");
  await expect(page.getByRole("heading", { name: /Your first article is (written|being written)/ })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("aside[aria-label='Your trial']")).toBeVisible();
});

test("a lost connection says it is reconnecting and never ends the run", async ({ page, signedIn }) => {
  void signedIn;
  await forceGate(page);
  // The first few reads of the run fail as a dropped connection would.
  let dropped = 0;
  await page.route("**/api/onboard/state**", async (route) => {
    if (dropped < 3) {
      dropped += 1;
      await route.abort("internetdisconnected");
    } else {
      await route.continue();
    }
  });
  await startSetup(page);
  await expect(page.getByText(/Reconnecting… The work carries on/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Setup did not finish|lost contact/)).toHaveCount(0);
  // The connection comes back: the run is picked up where it is, and ends on the gate.
  await expect(page.getByRole("heading", { name: /Your first article is (written|being written)/ })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Reconnecting…/)).toHaveCount(0);
  expect(dropped).toBe(3);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true });

  test("the price box's button is full width and the bar fits", async ({ page, signedIn }) => {
    void signedIn;
    await forceGate(page);
    await startSetup(page);
    await expect(page.getByRole("heading", { name: /Your first article is (written|being written)/ })).toBeVisible({ timeout: 45_000 });
    const start = page.locator("#start-trial").getByRole("button", { name: "Start 7-day trial" });
    expect((await start.boundingBox())!.width).toBeGreaterThanOrEqual(375 - 32 - 42 - 1);
    // Nothing on the page is wider than the phone.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, "b17-gate-375");
  });
});

/** A finished first look on the site, as the worker leaves the row; finished two hours ago, so the gate (not the run screen) opens. */
async function seedRun(account: { accountId: string; workspaces: { id: string }[] }, row: Record<string, unknown>) {
  const at = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  const { error } = await admin()
    .from("onboarding_runs")
    .insert({ workspace_id: account.workspaces[0].id, account_id: account.accountId, started_at: at, updated_at: at, finished_at: at, planned: [], keywords_found: 0, ...row });
  if (error) throw new Error(`seed run: ${error.message}`);
}

test.describe("after a setup that planned nothing or met an outage", () => {
  test.use({ accountShape: { workspaces: [{ domain: `acme-b17-${Date.now().toString(36)}.example`, onboarded: true }] } });

  test("'Change what we found and try again' reopens the wizard over the saved profile and runs once more", async ({ page, account }) => {
    await seedRun(account, {
      status: "nothing_planned",
      phases: [
        { phase: "scanning", status: "done" },
        { phase: "keywords", status: "done", detail: "Found 6 keywords worth tracking." },
        { phase: "pages", status: "done" },
        { phase: "planning", status: "skipped", detail: "No keyword clear enough to plan yet." },
        { phase: "drafting", status: "skipped" },
      ],
      empty_pool: { stage: "qualification", cause: "buyer_mismatch", keywords: 6, qualified: 0, rejected: { buyer_mismatch: 6 }, pending: {}, summary: "None of 6 qualified." },
    });
    await forceGate(page);
    await signIn(page, account.email, "/onboarding");
    await expect(page.getByRole("heading", { name: "We did not find a clear first topic yet" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Start 7-day trial/ })).toHaveCount(0);
    await shot(page, "b17-nothing-planned-1280");

    await page.getByRole("button", { name: "Change what we found and try again" }).click();
    await expect(page.getByRole("heading", { name: "Change what we found" })).toBeVisible();
    await expect(page.getByText("You get one more free try before the trial", { exact: false })).toBeVisible();
    // A way back that spends nothing: the ending again, and still one run.
    await page.getByRole("button", { name: "Back without changing anything" }).click();
    await expect(page.getByRole("heading", { name: "We did not find a clear first topic yet" })).toBeVisible();
    const { count: still } = await admin().from("onboarding_runs").select("id", { count: "exact", head: true }).eq("workspace_id", account.workspaces[0].id);
    expect(still).toBe(1);
    await page.getByRole("button", { name: "Change what we found and try again" }).click();
    await expect(page.getByRole("heading", { name: "Change what we found" })).toBeVisible();
    await page.getByLabel("Add something people buy from you").fill("guided walking holidays");
    await page.getByLabel("Add something people buy from you").press("Enter");
    await page.getByRole("button", { name: "Try again with these changes" }).click();

    // A fresh run, not the old one replayed: it ends on an article.
    await expect(page.getByRole("heading", { name: /Your first article is (written|being written)/ })).toBeVisible({ timeout: 60_000 });
    const { data: runs } = await admin().from("onboarding_runs").select("id, status").eq("workspace_id", account.workspaces[0].id);
    expect((runs ?? []).length).toBe(2);
    const { data: ws } = await admin().from("workspaces").select("business_profile").eq("id", account.workspaces[0].id).single();
    expect((ws?.business_profile as { offerings?: string[] }).offerings).toContain("guided walking holidays");
  });

  test("a provider outage says it is ours, with no retry button and no card", async ({ page, account }) => {
    await seedRun(account, {
      status: "partial",
      phases: [
        { phase: "scanning", status: "done" },
        { phase: "keywords", status: "failed", cause: "provider", detail: "Our search-data provider did not answer, so no search was checked yet. That is a problem on our side, not your site." },
        { phase: "pages", status: "done" },
        { phase: "planning", status: "skipped", detail: "No keyword clear enough to plan yet." },
        { phase: "drafting", status: "skipped" },
      ],
    });
    await forceGate(page);
    await signIn(page, account.email, "/onboarding");
    await expect(page.getByRole("heading", { name: "We could not reach our search data just now" })).toBeVisible();
    await expect(page.getByText("not with acme-b17-", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: /Run setup again|Start 7-day trial|Change what we found/ })).toHaveCount(0);
    await expect(page.getByText(/Setup did not finish/)).toHaveCount(0);
    await shot(page, "b17-provider-down-1280");
  });
});

test.describe("while the run is still reading the site", () => {
  test.use({ accountShape: { workspaces: [{ domain: `acme-restart-${Date.now().toString(36)}.example`, onboarded: true }] } });

  test("'Wrong? Fix it and start over' stops the run and opens 'Change what we found', whose button runs it again", async ({ page, account }) => {
    // A live run still finding searches, as the worker leaves it mid-way: no
    // worker is behind this row, so it stays in the window the link is for.
    const now = new Date().toISOString();
    const { error } = await admin()
      .from("onboarding_runs")
      .insert({
        workspace_id: account.workspaces[0].id,
        account_id: account.accountId,
        status: "running",
        started_at: now,
        updated_at: now,
        planned: [],
        phases: [
          { phase: "scanning", status: "done" },
          { phase: "keywords", status: "active" },
        ],
      });
    if (error) throw new Error(`seed run: ${error.message}`);
    await forceGate(page);
    await signIn(page, account.email, "/onboarding");
    await expect(page.getByRole("heading", { name: "What we understood" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Settings opens when your trial starts", { exact: false })).toHaveCount(0);
    await shot(page, "restart-early-1280");

    await page.getByRole("button", { name: "Wrong? Fix it and start over" }).click();
    await expect(page.getByRole("heading", { name: "Change what we found" })).toBeVisible();
    const { data: stopped } = await admin().from("onboarding_runs").select("status, error").eq("workspace_id", account.workspaces[0].id).single();
    expect(stopped).toMatchObject({ status: "error", error: "Setup was stopped to change what we found." });

    await page.getByLabel("Add something people buy from you").fill("guided walking holidays");
    await page.getByLabel("Add something people buy from you").press("Enter");
    await page.getByRole("button", { name: "Try again with these changes" }).click();
    // A fresh run on the corrected profile, not the stopped one resumed.
    await expect(page.getByRole("heading", { name: /Your first article is (written|being written)/ })).toBeVisible({ timeout: 60_000 });
    const { data: runs } = await admin().from("onboarding_runs").select("status").eq("workspace_id", account.workspaces[0].id);
    expect((runs ?? []).length).toBe(2);
    const { data: ws } = await admin().from("workspaces").select("business_profile").eq("id", account.workspaces[0].id).single();
    expect((ws?.business_profile as { offerings?: string[] }).offerings).toContain("guided walking holidays");
  });
});

/** An article being written to an outline, behind the gate: the reader's case. */
async function seedOutlinedArticle(account: { accountId: string; workspaces: { id: string }[] }) {
  const db = admin();
  const sections = ["Key takeaways", "How to choose a kit", "Kits compared", "Common mistakes", "Frequently asked questions"];
  const { data: article, error } = await db
    .from("articles")
    .insert({
      workspace_id: account.workspaces[0].id,
      title: "Acme kits: how to choose one",
      slug: `acme-kits-${Date.now().toString(36)}`,
      keyword: "acme kits",
      status: "drafting",
      instructions_snapshot: {
        outline: { version: 1, title: "Acme kits: how to choose one", sections, closing: null, targetWordCount: 1400, sources: [], model: "fixture", createdAt: new Date().toISOString() },
      },
    })
    .select("id")
    .single();
  if (error || !article) throw new Error(`seed article: ${error?.message}`);
  await seedRun(account, { status: "done", article_id: article.id, phases: [{ phase: "drafting", status: "done" }] });
}

/** The article's text, long enough to run past the screen, with a table of long words. */
function articleHtml(): string {
  const para = (i: number) => `<p>Paragraph ${i}: a kit is easier to keep than to start, and this section says which parts of it matter most for a beginner choosing one for the first time.</p>`;
  const table =
    "<table><thead><tr><th>Kit</th><th>Includes</th><th>Best for</th></tr></thead><tbody>" +
    "<tr><td>Cross-stitch starter</td><td>Embroidery hoop, threads</td><td>Beginners</td></tr>" +
    "<tr><td>Needlepoint deluxe</td><td>Canvas, wools, needles</td><td>Experienced</td></tr></tbody></table>";
  return `<h2>Key takeaways</h2>${para(1)}${table}${Array.from({ length: 24 }, (_, i) => para(i + 2)).join("")}`;
}

/** Serves the reader's poll from `html`, growing by a slice each answer, then done. */
async function streamArticle(page: Page, html: string, opts: { slices?: number } = {}) {
  const slices = opts.slices ?? 6;
  let calls = 0;
  await page.route("**/api/onboard/first-article?**", async (route) => {
    calls += 1;
    const done = calls > slices;
    const cut = done ? html.length : Math.floor((html.length * calls) / (slices + 1));
    // Cut at a tag boundary, as the server's cleaned stream would be.
    const part = done ? html : html.slice(0, html.lastIndexOf("</p>", cut) + 4 || cut);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ articleId: "a", html: part, done, progress: { stage: done ? null : "writing", stageMs: 1000, sectionsDone: [0], sections: 5, words: Math.round(part.length / 6) } }),
    });
  });
}

test.describe("the article being written", () => {
  test.use({
    accountShape: { workspaces: [{ domain: `acme-b17-r${Date.now().toString(36)}.example`, onboarded: true }] },
    viewport: { width: 1280, height: 560 },
  });

  test("types at a reading pace, never scrolls the page, offers 'Jump to the latest', and keeps the trial a click away", async ({ page, account }) => {
    await seedOutlinedArticle(account);
    await forceGate(page);
    const html = articleHtml();
    await streamArticle(page, html, { slices: 15 });
    await signIn(page, account.email, "/onboarding");
    await expect(page.getByRole("heading", { name: /Your first article is (being written|written)/ })).toBeVisible();

    // Five seconds in: a reader's few hundred characters, not the backlog.
    await page.waitForTimeout(5_000);
    const shown = await page.locator(".article-text").evaluate((el) => (el.textContent ?? "").length);
    expect(shown).toBeGreaterThan(60);
    expect(shown).toBeLessThan(5 * 48 + 120);
    // The page did not move under the reader.
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    // The trial is a click away the whole time it is written: from lg it is
    // the rail's button, held beside the article (the slim bar is phone-only).
    await expect(page.locator("#start-trial").getByRole("button", { name: "Start 7-day trial" })).toBeInViewport();
    await shot(page, "b17-reader-writing-1280");

    // The caret runs below the screen: the pill offers the way down, and only on a click.
    await expect(page.getByRole("button", { name: "Jump to the latest" })).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await page.getByRole("button", { name: "Jump to the latest" }).click();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

    // The preview's links do not take the tab order from the trial button.
    const links = await page.locator(".article-text a[href]").evaluateAll((as) => as.map((a) => [a.getAttribute("target"), a.getAttribute("tabindex")]));
    for (const [target, tab] of links) expect([target, tab]).toEqual(["_blank", "-1"]);
  });
});

test.describe("the article's table on a phone", () => {
  test.use({
    accountShape: { workspaces: [{ domain: `acme-b17-t${Date.now().toString(36)}.example`, onboarded: true }] },
    viewport: { width: 375, height: 740 },
    isMobile: true,
    hasTouch: true,
  });

  test("keeps its words whole and scrolls sideways", async ({ page, account }) => {
    await seedOutlinedArticle(account);
    await forceGate(page);
    await streamArticle(page, articleHtml(), { slices: 0 });
    await signIn(page, account.email, "/onboarding");
    const cell = page.locator(".article-text td", { hasText: "Cross-stitch starter" });
    await expect(cell).toBeVisible({ timeout: 30_000 });
    const style = await cell.evaluate((td) => ({ wrap: getComputedStyle(td).overflowWrap, width: td.getBoundingClientRect().width }));
    expect(style.wrap).toBe("normal");
    expect(style.width).toBeGreaterThanOrEqual(120);
    // "Cross-stitch" is never cut inside the word: its first line holds it whole.
    const firstLine = await cell.evaluate((td) => {
      const range = document.createRange();
      range.selectNodeContents(td);
      const rects = [...range.getClientRects()];
      return rects.length ? Math.round(rects[0].width) : 0;
    });
    expect(firstLine).toBeGreaterThan(60);
    const table = page.locator(".article-text table");
    expect(await table.evaluate((t) => t.scrollWidth >= t.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await shot(page, "b17-reader-table-375");
  });
});
