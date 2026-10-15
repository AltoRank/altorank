import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The gate's exits (UX audit 2026-10-12, #3 and #16), as markup: a soft
// "email me this article" under the trial button, and a way forward from a
// setup that planned nothing or fell short - offered only when the spend
// gate would start the run.

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
vi.mock("posthog-js", () => ({ default: { identify: () => undefined, capture: () => undefined, reset: () => undefined } }));
vi.mock("@/app/actions/auth", () => ({ signOut: async () => undefined }));
vi.mock("@/app/actions/first-look-exits", () => ({ emailWhenReady: async () => ({ ok: true, email: "x" }), emailFirstArticle: async () => ({ ok: true, email: "x" }) }));
vi.mock("@/app/actions/onboarding-wizard", () => {
  const never = () => new Promise(() => undefined);
  return { proposeProfile: never, resolveCompetitor: never, suggestCompetitors: never, saveProfile: never, saveProfileDraft: never, discoverSiteDetails: never, saveSiteDetails: never, completeWizard: never };
});

import { OnboardingWizard } from "../wizard";
import { EMPTY_PROFILE } from "@/lib/onboarding/profile-shape";
import type { OnboardingRunRow } from "@/lib/onboarding/events";
import type { FirstArticleCard } from "@/lib/onboarding/first-article";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

const OLD = "2026-09-28T10:05:00.000Z";
const run = (over: Partial<OnboardingRunRow>): OnboardingRunRow => ({
  id: "r1",
  workspace_id: "ws1",
  status: "nothing_planned",
  phases: [
    { phase: "scanning", status: "done" },
    { phase: "keywords", status: "done" },
    { phase: "pages", status: "done" },
    { phase: "planning", status: "skipped", detail: "No keyword clear enough to plan yet." },
    { phase: "drafting", status: "skipped" },
  ],
  planned: [],
  keywords_found: 40,
  article_id: null,
  error: null,
  empty_pool: { stage: "keywords", cause: null, keywords: 0, qualified: 0, rejected: {}, pending: {}, summary: "" },
  started_at: OLD,
  updated_at: OLD,
  finished_at: OLD,
  ...over,
});

function gate(over: Partial<Parameters<typeof OnboardingWizard>[0]> = {}) {
  return renderToStaticMarkup(
    <OnboardingWizard
      workspaceId="ws1"
      userId="u1"
      domain="acme-shop.example"
      weeklyLimit={7}
      freeDrafts={1}
      trialEligible
      canBuy
      fullArticle
      alreadyOnboarded
      initialProfile={{ ...EMPTY_PROFILE, name: "Acme", offerings: ["kits"] }}
      initialSite={{ sitemapUrl: "", blogRootUrl: "", exampleArticleUrls: [] }}
      askAttribution={false}
      offer={{ endsAt: "2026-10-19T12:00:00.000Z", taxAdded: false }}
      preTrialSetup={{ setupAllowed: true, firstAttempted: false, followUp: false }}
      initialRun={{ run: run({}), article: null, stale: false }}
      {...over}
    />,
  );
}

describe("the gate's way forward when setup planned nothing", () => {
  it("offers to change what we found and try again, once, when the spend gate would allow it", () => {
    const html = text(gate());
    expect(html).toContain("We did not find a clear first topic yet");
    expect(html).toContain("Change what we found and try again");
    expect(html).toContain("One more try is free");
  });

  it("offers nothing the server would refuse", () => {
    const html = text(gate({ preTrialSetup: { setupAllowed: false, firstAttempted: false, followUp: false } }));
    expect(html).not.toContain("Change what we found");
  });

  it("offers the change beside the retry when setup fell short", () => {
    const html = text(gate({ initialRun: { run: run({ status: "partial", empty_pool: null, phases: [{ phase: "keywords", status: "failed", detail: "x" }] }), article: null, stale: false } }));
    expect(html).toContain("Run setup again");
    expect(html).toContain("Change what we found first");
    expect(html).not.toMatch(/plans the month/);
  });

  it("asks nothing of a member who is not the owner", () => {
    expect(text(gate({ canBuy: false }))).not.toContain("Change what we found");
  });
});

describe("the soft exit under the trial button", () => {
  const ARTICLE: FirstArticleCard = {
    id: "a1", title: "Acme kits", keyword: "acme kits", scheduledDate: null, outline: ["One"], wordCount: 1400, sources: 4, verdict: "clean", more: 0, labels: [], state: "written",
  };

  it("is offered to the owner with an article, below the button and quieter than it", () => {
    const markup = gate({ firstArticle: ARTICLE, initialRun: null, initialHtml: "<p>One.</p>" });
    const html = text(markup);
    expect(html).toContain("Not ready yet? Email me this article");
    expect(markup.indexOf("Start 7-day trial")).toBeLessThan(markup.indexOf("Email me this article"));
  });

  it("is not offered while the article is still being written: the one send would go on an outline", () => {
    expect(text(gate({ firstArticle: { ...ARTICLE, state: "outlined" }, initialRun: null }))).not.toContain("Email me this article");
  });

  it("is not offered to a member who cannot start the trial", () => {
    expect(text(gate({ firstArticle: ARTICLE, initialRun: null, canBuy: false }))).not.toContain("Email me this article");
  });
});

describe("the provider-down ending", () => {
  // Finished an hour ago: inside the overnight retry's window.
  const recent = new Date(Date.now() - 60 * 60_000).toISOString();
  const down = run({
    status: "partial",
    empty_pool: null,
    started_at: recent,
    updated_at: recent,
    finished_at: recent,
    phases: [
      { phase: "scanning", status: "done" },
      { phase: "keywords", status: "failed", cause: "provider", detail: "Our search-data provider did not answer." },
      { phase: "planning", status: "skipped" },
      { phase: "drafting", status: "skipped" },
    ],
  });

  it("says it is ours, offers no paid retry and asks for no card, and promises the overnight retry only when it may run", () => {
    const html = text(gate({ initialRun: { run: down, article: null, stale: false } }));
    expect(html).toContain("We could not reach our search data just now");
    expect(html).toContain("not with acme-shop.example");
    expect(html).toContain("We try again automatically");
    expect(html).not.toMatch(/Run setup again|Start 7-day trial|Change what we found|Setup did not finish/);
    const refused = text(gate({ initialRun: { run: down, article: null, stale: false }, preTrialSetup: { setupAllowed: false, firstAttempted: false, followUp: false } }));
    expect(refused).not.toContain("We try again");
  });

  it("offers the retry button instead of a promise once the run is past the sweep's window", () => {
    const old = { ...down, started_at: OLD, updated_at: OLD, finished_at: OLD };
    const html = text(gate({ initialRun: { run: old, article: null, stale: false } }));
    expect(html).not.toContain("We try again automatically");
    expect(html).toContain("Run setup again");
  });
});
