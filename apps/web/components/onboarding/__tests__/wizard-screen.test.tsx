import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// "Check what we found", as markup (no DOM in this repo's unit tier): the
// five fixes from the UX audit of 2026-10-12 that can be read off the page.
// The ones that need a browser - a section that stays open while typing, a
// badge that waits for blur, the bar's real height - are in
// e2e/wizard-ux.spec.ts.

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
vi.mock("posthog-js", () => ({ default: { identify: () => undefined, capture: () => undefined, reset: () => undefined } }));
vi.mock("@/app/actions/auth", () => ({ signOut: async () => undefined }));
vi.mock("@/app/actions/onboarding-wizard", () => {
  const never = () => new Promise(() => undefined);
  return {
    proposeProfile: never,
    resolveCompetitor: never,
    suggestCompetitors: never,
    saveProfile: never,
    saveProfileDraft: never,
    discoverSiteDetails: never,
    saveSiteDetails: never,
    completeWizard: never,
  };
});

import { OnboardingWizard, Section } from "../wizard";
import { CompetitorStep } from "../competitor-step";
import { ChipList } from "@/components/settings/fields";
import { EMPTY_PROFILE, type BusinessProfile } from "@/lib/onboarding/profile-shape";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

const PROFILE: BusinessProfile = {
  ...EMPTY_PROFILE,
  name: "Acme Physio",
  language: "Italian",
  country: "Italy",
  description: "Acme Physio treats back pain. Book online.",
  audiences: ["Office workers with back pain"],
  offerings: ["back pain treatment"],
  competitors: [],
};

function wizard(over: Partial<Parameters<typeof OnboardingWizard>[0]> = {}) {
  return renderToStaticMarkup(
    <OnboardingWizard
      workspaceId="ws1"
      userId="u1"
      domain="acme-physio.example"
      weeklyLimit={7}
      freeDrafts={1}
      trialEligible
      canBuy
      fullArticle
      initialProfile={PROFILE}
      initialSite={{ sitemapUrl: "", blogRootUrl: "https://acme-physio.example/blog/", exampleArticleUrls: [] }}
      offer={{ endsAt: "2026-10-19T12:00:00.000Z", taxAdded: false }}
      {...over}
    />,
  );
}

/** The markup of the section card whose heading is `title`. */
function section(html: string, title: string): string {
  const at = html.indexOf(`>${title}</h2>`);
  const start = html.lastIndexOf('<div class="rounded-[10px] border border-line bg-panel"', at);
  const next = html.indexOf('<div class="rounded-[10px] border', at);
  return html.slice(start, next === -1 ? undefined : next);
}

describe("the wizard's main button", () => {
  it("promises what the next three minutes deliver, and no 30-day plan", () => {
    const html = text(wizard());
    expect(html).toContain("Next: we read your site, pick your first topic and write your first article while you watch, in about 3 minutes.");
    expect(html).toContain("Read it free; the 7-day trial lets you publish it and writes the rest.");
    expect(html).toContain("About 3 minutes. Read your first article free.");
    expect(html).not.toMatch(/30-day|thirty/i);
    // Before the trial the run writes one article: the button says so.
    expect(html).toContain("Write my first article");
    expect(html).not.toContain("Plan my first articles");
  });

  it("does not say free to someone who cannot read it before the trial", () => {
    const html = text(wizard({ fullArticle: false, canBuy: false }));
    expect(html).not.toMatch(/\bfree\b/i);
  });

  it("stacks under 640px: one short line over a full-width button", () => {
    const html = wizard();
    expect(html).toContain("flex-col gap-2 px-4 py-3 sm:flex-row");
    expect(html).toMatch(/<button[^>]*class="[^"]*w-full justify-center[^"]*sm:w-auto/);
    expect(html).toContain('class="m-0 hidden text-[12.5px] leading-[1.5] text-ink-2 sm:block"');
    expect(html).toContain('class="m-0 text-[12.5px] leading-[1.5] text-ink-2 sm:hidden"');
  });
});

describe("competitors are optional", () => {
  it("says so, and asks for a name rather than a domain", () => {
    const html = text(wizard());
    expect(html).toContain("Who do customers compare you with?");
    expect(html).toContain("Optional.");
    expect(html).toContain("Its name is enough.");
    expect(html).not.toContain("Name at least one");
    expect(html).not.toContain("acmegym");
  });

  it("shows names beside websites, each with a 32px remove target", () => {
    const html = renderToStaticMarkup(
      <CompetitorStep chosen={["rival.example"]} names={["Studio Acme"]} sizes={{}} suggestions={[]} loading={false} onChange={() => undefined} resolve={async () => null} />,
    );
    expect(text(html)).toContain("Studio Acme name only");
    expect(html).toContain('aria-label="Remove Studio Acme"');
    expect(html.match(/grid h-8 w-8 shrink-0/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Add a business your customers compare you with"');
  });

  it("says when the lookup for similar businesses failed", () => {
    const html = text(renderToStaticMarkup(
      <CompetitorStep chosen={[]} sizes={{}} suggestions={[]} loading={false} lookupFailed onChange={() => undefined} resolve={async () => null} />,
    ));
    expect(html).toContain("We could not look up similar businesses just now.");
  });
});

describe("sections", () => {
  it("open from their initial state only", () => {
    expect(renderToStaticMarkup(<Section title="T" line="l" initialOpen state="attention">x</Section>)).toContain("<details open=\"\"");
    expect(renderToStaticMarkup(<Section title="T" line="l" initialOpen={false} state="found">x</Section>)).not.toContain("<details open");
  });

  it("keeps the content section closed, optional and free of setup jargon up front", () => {
    const html = wizard();
    const content = section(html, "Where your content lives");
    expect(content).not.toContain("<details open");
    expect(text(content)).not.toContain("Needs a look");
    // The blog address first; the sitemap, the example articles and Search
    // Console behind "Advanced (optional)".
    const advanced = content.indexOf("Advanced (optional)");
    expect(advanced).toBeGreaterThan(content.indexOf("Blog address"));
    for (const later of ["Sitemap", "Your best writing", "Connect Google Search Console"]) expect(content.indexOf(later)).toBeGreaterThan(advanced);
    // One link, not a button inside a link.
    expect(content).toMatch(/<a [^>]*href="\/connect\/google"[^>]*>Connect<\/a>/);
  });
});

describe("language and market", () => {
  it("are on screen with the business section closed, with a Change link", () => {
    const business = text(section(wizard(), "About your business"));
    expect(business).toContain("Language and market: Italian · Italy");
    expect(business).toContain("Change");
    // The name is not said twice.
    expect(business).toContain("Acme Physio treats back pain.");
    expect(business).not.toContain("Acme Physio · Acme Physio");
  });
});

describe("mobile inputs", () => {
  it("are 16px below sm, so iOS does not zoom, with a visible focus ring", () => {
    const html = renderToStaticMarkup(<ChipList items={["a"]} onChange={() => undefined} placeholder="e.g. x" label="Add a thing" max={3} />);
    expect(html).toMatch(/<input[^>]*class="[^"]*text-base sm:text-\[13px\][^"]*focus-visible:ring-2/);
    expect(html).toContain('aria-label="Add a thing"');
    expect(html).toContain("grid h-8 w-8 shrink-0");
  });
});
