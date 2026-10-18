import { test, expect } from "./fixtures/test";
import { admin, createAccount, destroyAccount, signIn, uniqueTag } from "./fixtures/account";

/**
 * "Check what we found", in a real browser: the five fixes from the UX audit
 * of 2026-10-12 that markup alone cannot show (components/onboarding/
 * __tests__/wizard-screen.test.tsx has the rest).
 *
 * - Nothing on the screen is a wall: competitors are optional, a name is
 *   kept as typed, and the one blocker left shows beside the button and
 *   takes the person to its field.
 * - A section never shuts while typing; its badge catches up on blur.
 * - Answers save as you go, and a reload resumes them.
 * - A failed read starts from the country domain's language and market.
 * - On a phone the bar stacks, inputs do not zoom and nothing is under it.
 */

test("the main button is never blocked by competitors, and its one blocker shows beside it", async ({ page, signedIn }) => {
  const ws = signedIn.workspaces[0];
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByRole("heading", { name: "Check what we found" })).toBeVisible();
  await expect(page.getByText("tripcraft.example")).toBeVisible();

  // Every competitor removed, a name typed and not added.
  for (const rival of ["tripcraft.example", "wanderly.example"]) await page.getByRole("button", { name: `Remove ${rival}` }).click();
  await page.getByLabel("Add a business your customers compare you with").fill("Bottega Acme");

  // Nothing to plan from: the bar says so, beside the button, and the
  // offerings box has focus.
  const description = page.locator("details", { has: page.getByRole("heading", { name: "About your business" }) });
  await description.locator(":scope > summary").click();
  await page.getByLabel(/^Description/).fill("");
  for (const o of ["slow travel itineraries italy", "italy train route guides", "verified walking routes"]) {
    await page.getByRole("button", { name: `Remove ${o}` }).click();
  }
  await page.getByRole("button", { name: /^(Write my first article|Plan my first articles)$/ }).click();
  const bar = page.locator("div.fixed.bottom-0");
  await expect(bar.getByRole("alert")).toHaveText("Add one thing people buy from you, so we know what to write about.");
  await expect(page.getByLabel("Add something people buy from you")).toBeFocused();

  // Fixed: one offering. The alert clears as soon as it is added, before
  // any click, and the click goes through with no competitor.
  await page.getByLabel("Add something people buy from you").fill("walking holidays in italy");
  await page.getByLabel("Add something people buy from you").press("Enter");
  await expect(bar.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: /^(Write my first article|Plan my first articles)$/ }).click();
  await expect(page.getByRole("heading", { name: "Creating your content plan" })).toBeVisible();

  const { data } = await admin().from("workspaces").select("business_profile").eq("id", ws.id).single();
  const saved = data?.business_profile as { competitors: string[]; competitorNames?: string[]; confirmedAt?: string };
  expect(saved.competitors).toEqual([]);
  // The name typed and never added is kept, as a name.
  expect(saved.competitorNames).toEqual(["Bottega Acme"]);
  expect(saved.confirmedAt).toBeTruthy();
});

test("a section stays open while typing, its badge waits for blur, and answers resume after a reload", async ({ page }) => {
  // A failed read on an Italian country domain (never fetched: the stubs
  // read nothing for an unreadable. host).
  const account = await createAccount({ workspaces: [{ domain: `unreadable.acme-b17-${uniqueTag()}.it` }] });
  try {
    await signIn(page, account.email);
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByText("We could not read enough of this site", { exact: false })).toBeVisible();

    // Language and market from the country domain, said as a guess, with a Change link.
    const business = page.locator("details", { has: page.getByRole("heading", { name: "About your business" }) });
    await expect(business).toHaveAttribute("open", "");
    await business.locator(":scope > summary").click();
    await expect(page.getByText("Italian · Italy")).toBeVisible();
    await expect(page.getByText("(guessed from your site)")).toBeVisible();
    await page.getByRole("button", { name: "Change" }).click();
    await expect(business).toHaveAttribute("open", "");
    await expect(page.getByLabel("Language")).toBeFocused();
    await expect(page.getByLabel("Language")).toHaveValue("Italian");
    await expect(page.getByLabel(/^Market/)).toHaveValue("Italy");

    // No blog: closed, calm, optional.
    const content = page.locator("details", { has: page.getByRole("heading", { name: "Where your content lives" }) });
    const card = page.locator("div.rounded-\\[10px\\]", { has: content });
    await expect(content).not.toHaveAttribute("open", "");
    await expect(card).toContainText("No blog yet");
    await expect(card).toContainText("Optional");
    await expect(card).not.toContainText("Needs a look");

    // Typed into a field one key at a time, the section stays open and the
    // field keeps focus; the badge holds until focus leaves.
    await content.locator(":scope > summary").click();
    await page.getByText("Advanced (optional)").click();
    const sitemap = page.getByLabel(/^Sitemap/);
    const url = "https://acme.example/sitemap.xml";
    await sitemap.pressSequentially(url);
    await expect(content).toHaveAttribute("open", "");
    await expect(sitemap).toBeFocused();
    await expect(sitemap).toHaveValue(url);
    await expect(content.locator(":scope > summary")).toContainText("Optional");
    await page.getByRole("heading", { name: "Check what we found" }).click();
    await expect(content.locator(":scope > summary")).toContainText("Found");

    // One offering, then the draft is on disk, unconfirmed.
    await page.getByLabel("Add something people buy from you").fill("guided walks");
    await page.getByLabel("Add something people buy from you").press("Enter");
    await expect(page.getByText("Your answers are saved as you go.")).toBeVisible();
    const { data } = await admin().from("workspaces").select("business_profile, sitemap_url, onboarded_at").eq("id", account.workspaces[0].id).single();
    const draft = data?.business_profile as { offerings: string[]; language: string; country: string; confirmedAt?: string };
    expect(draft.offerings).toEqual(["guided walks"]);
    expect([draft.language, draft.country]).toEqual(["Italian", "Italy"]);
    expect(draft.confirmedAt).toBeUndefined();
    expect(data?.sitemap_url).toBe(url);
    expect(data?.onboarded_at).toBeNull();

    // A reload resumes it, without reading the site again.
    await page.reload();
    await expect(page.getByText("Here is what we have for", { exact: false })).toBeVisible();
    await expect(page.getByText("guided walks", { exact: true })).toBeVisible();
    // No name yet, so the business section opens, on the saved language and market.
    await expect(page.getByLabel("Language")).toHaveValue("Italian");
    await expect(page.getByLabel(/^Market/)).toHaveValue("Italy");
  } finally {
    await destroyAccount(account);
  }
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });

  test("the bar stacks, inputs do not zoom, targets are big enough and nothing hides under the bar", async ({ page, signedIn }) => {
    void signedIn;
    await expect(page.getByRole("heading", { name: "Check what we found" })).toBeVisible();
    const bar = page.locator("div.fixed.bottom-0");
    const button = bar.getByRole("button", { name: /^(Write my first article|Plan my first articles)$/ });
    const barBox = (await bar.boundingBox())!;
    const buttonBox = (await button.boundingBox())!;
    // Full width (16px gutters) and one short line above it.
    expect(buttonBox.width).toBeGreaterThanOrEqual(375 - 32 - 1);
    expect(barBox.height).toBeLessThan(120);
    await expect(bar.getByText(/^About 3 minutes\./)).toBeVisible();
    await expect(bar.getByText("Next: we read your site", { exact: false })).toBeHidden();

    // 16px text in every input, so iOS does not zoom on focus.
    const sizes = await page.locator("input:not([type=checkbox]):not([type=radio]), select, textarea").evaluateAll((els) =>
      els.map((el) => getComputedStyle(el).fontSize),
    );
    expect(sizes.length).toBeGreaterThan(0);
    expect(new Set(sizes)).toEqual(new Set(["16px"]));

    // Remove targets at least 32px square.
    const remove = page.getByRole("button", { name: /^Remove / }).first();
    const r = (await remove.boundingBox())!;
    expect(r.width).toBeGreaterThanOrEqual(32);
    expect(r.height).toBeGreaterThanOrEqual(32);

    // Scrolled to the end, the last section clears the bar. The page can
    // still grow after the first scroll (once measured at 700px against a
    // 574px bar top, off the bottom of the screen), so scroll and measure
    // again until it settles; a section that really sits under the bar
    // still fails.
    const last = page.locator("div.rounded-\\[10px\\]", { has: page.getByRole("heading", { name: "Where your content lives" }) });
    await expect.poll(async () => {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      const lastBox = (await last.boundingBox())!;
      const barTop = (await bar.boundingBox())!.y;
      return lastBox.y + lastBox.height - barTop;
    }).toBeLessThanOrEqual(0);
  });
});
