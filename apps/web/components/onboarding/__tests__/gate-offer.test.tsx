import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The gate's offer, as markup: the price box under the article and the slim
// bar that keeps it a click away (UX audit 2026-10-12, #6, #9, #10).

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
vi.mock("@/app/actions/billing", () => ({ createCheckoutSession: async () => ({ ok: false, error: "test" }) }));
vi.mock("@/app/actions/attribution", () => ({ saveAttribution: async () => undefined }));

import { GateTop } from "../first-look-gate";
import { TrialPriceBox } from "@/components/billing/trial-offer";
import { PLAN_PRICES, PLAN_YEARLY_PRICES } from "@/lib/stripe";
import type { FirstArticleCard } from "@/lib/onboarding/first-article";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
const FACTS = { endsAt: "2026-10-19T09:30:00.000Z", taxAdded: false };

const ARTICLE: FirstArticleCard = {
  id: "a1",
  title: "Acme kits: how to choose one",
  keyword: "acme kits",
  scheduledDate: "2026-10-12",
  outline: ["Key takeaways", "What is in a kit?"],
  wordCount: 1700,
  sources: 0,
  verdict: null,
  more: 0,
  labels: [],
  state: "outlined",
};

function gate(article: FirstArticleCard, initialHtml: string | null = null) {
  return renderToStaticMarkup(
    <GateTop workspaceId="ws1" canBuy ending="article" heading="" lede="" firstArticle={article} planned={[]} fullArticle initialHtml={initialHtml} offer={FACTS} />,
  );
}

describe("the price box", () => {
  it("names the next articles, then the price line over the button, the reminder and the way out", () => {
    const markup = renderToStaticMarkup(<TrialPriceBox canBuy interval="month" onInterval={() => undefined} facts={FACTS} nextArticles={["Kitchen tiles", "Bathroom tiles", "Floor tiles", "Wall tiles"]} />);
    const html = text(markup);
    expect(html).toContain("Start your free 7-day trial");
    // No plan name over the default offer: it means nothing on a first visit.
    expect(html).not.toContain("Managed plan");
    expect(html).toContain("Your next articles Kitchen tiles Bathroom tiles Floor tiles Start your trial to have these written. Review each article, then copy it to your website.");
    expect(html).not.toContain("Wall tiles");
    expect(html).toContain(`Card required. €0 today. Then ${PLAN_PRICES.starter}/month from October 19 unless you cancel. Start 7-day trial`);
    expect(html).not.toMatch(/No extra costs/);
    expect(html).toContain("We email you 3 days before the trial ends");
    expect(html).toContain("Cancel in Settings › Billing before the trial ends and nothing is charged.");
    expect(html).toContain("Plan details Up to 100 articles a month, written at the pace you set Nothing publishes until you approve it Writing and topic research included");
    expect(html).toContain(`Or pay yearly: ${PLAN_YEARLY_PRICES.starter}/year, two months free`);
    expect(html).not.toMatch(/renewal/i);
  });

  it("makes the trial button the full-width primary, and yearly a quiet link", () => {
    const markup = renderToStaticMarkup(<TrialPriceBox canBuy interval="year" onInterval={() => undefined} facts={FACTS} />);
    expect(markup).toMatch(/<button[^>]*class="[^"]*w-full[^"]*"[^>]*>Start 7-day trial<\/button>/);
    expect(text(markup)).toContain(`Then ${PLAN_YEARLY_PRICES.starter}/year from October 19 unless you cancel.`);
    expect(text(markup)).toContain("Switch back to monthly");
  });

  it("offers Agency as a quiet switch under Managed, and quotes Agency's price once chosen (#280)", () => {
    const managed = text(renderToStaticMarkup(<TrialPriceBox canBuy interval="month" onInterval={() => undefined} plan="starter" onPlan={() => undefined} facts={FACTS} />));
    expect(managed).not.toContain("Managed plan");
    expect(managed).toContain(`Try Agency instead: ${PLAN_PRICES.growth}/month`);
    const agency = text(renderToStaticMarkup(<TrialPriceBox canBuy interval="month" onInterval={() => undefined} plan="growth" onPlan={() => undefined} facts={FACTS} />));
    expect(agency).toContain("Agency plan");
    expect(agency).toContain(`Then ${PLAN_PRICES.growth}/month from October 19 unless you cancel.`);
    expect(agency).toContain(`Back to Managed: ${PLAN_PRICES.starter}/month`);
  });

  it("tells a member who is not the owner who can start it, with no price", () => {
    const html = text(renderToStaticMarkup(<TrialPriceBox canBuy={false} interval="month" onInterval={() => undefined} facts={FACTS} />));
    expect(html).toContain("Only the account owner can start the trial");
    expect(html).not.toContain("€");
  });
});

describe("the slim bar", () => {
  it("is on screen while the article is being written, with the box's price line above its button", () => {
    const markup = gate(ARTICLE);
    expect(markup).toContain('data-testid="trial-bar"');
    expect(text(markup.slice(markup.indexOf('data-testid="trial-bar"')))).toContain(`Card required. €0 today. Then ${PLAN_PRICES.starter}/month from October 19 unless you cancel. Start 7-day trial`);
    // Clear of a phone's home bar.
    expect(markup).toContain("pb-[env(safe-area-inset-bottom)]");
  });

  it("is not drawn over a finished article from the first frame", () => {
    expect(gate({ ...ARTICLE, state: "written", wordCount: 1400 }, "<p>The text.</p>")).not.toContain('data-testid="trial-bar"');
  });

  it("stays, and the heading says being written, while a saved article's text is not in hand yet", () => {
    // The body is saved but the page has no text to show: "written" over an
    // empty box (8-20s on a loaded server) and no button on screen.
    const markup = gate({ ...ARTICLE, state: "written", wordCount: 1400 }, null);
    expect(markup).toContain('data-testid="trial-bar"');
    expect(text(markup)).toContain("Your first article is being written");
    expect(text(markup)).not.toContain("Email me a link to this article");
  });
});

describe("the return screen", () => {
  const WRITTEN: FirstArticleCard = { ...ARTICLE, state: "written", wordCount: 1400, verdict: "clean" };
  const back = (welcome: "returning" | "cancelled" | null, article: FirstArticleCard = WRITTEN) =>
    renderToStaticMarkup(
      <GateTop workspaceId="ws1" canBuy ending="article" heading="" lede="" firstArticle={article} planned={[]} fullArticle initialHtml="<p>The text.</p>" offer={FACTS} welcome={welcome} nextArticles={["Kitchen tiles", "Bathroom tiles"]} />,
    );

  it("says welcome back, the title and a way to read it, then the next articles, the price and the button, the article folded below", () => {
    const html = text(back("returning"));
    const order = ["Welcome back. Your article is saved.", "Acme kits: how to choose one", "Read your article", "Your next articles", "Kitchen tiles", "Card required. €0 today.", "Start 7-day trial", "Show the full article"];
    let at = -1;
    for (const line of order) {
      const i = html.indexOf(line, at + 1);
      expect(i, line).toBeGreaterThan(at);
      at = i;
    }
    expect(html).not.toContain("Your first article is written");
  });

  it("says nothing was charged after a cancelled checkout", () => {
    const html = text(back("cancelled"));
    expect(html).toContain("Your trial hasn't started. Nothing was charged.");
    expect(html).not.toContain("Welcome back");
  });

  it("is the usual gate without a finished article to come back to", () => {
    expect(text(back("returning", ARTICLE))).not.toContain("Welcome back");
    expect(text(back(null))).not.toContain("Welcome back");
  });
});
