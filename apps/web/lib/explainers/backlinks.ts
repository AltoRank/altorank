import type { Explainer } from "./types";

/**
 * Read from: app/(dashboard)/backlinks/page.tsx (the stat hints and the
 * hosting card), lib/seo/backlinks.ts via app/api/cron/serp/route.ts (weekly
 * sync inside the rank cron), components/dashboard/backlink-freshness.tsx
 * ("Check now"), lib/seo/exchange.ts (one article, one credit; settles on
 * publish), lib/types.ts (Backlink and BacklinkExchange). There is no
 * outreach, disavow or marketplace code anywhere in lib/ or app/.
 */
export const backlinksExplainer: Explainer = {
  id: "backlinks",
  title: "Backlinks",
  intro:
    "What we know about the links pointing at this site, the one way the product helps you earn more, and the things it will not do.",
  mountsAt: "app/(dashboard)/backlinks/page.tsx, PageHead actions (this track).",
  sections: [
    {
      title: "What we track",
      lead: "Links pointing at the site, read from DataForSEO's backlink index.",
      bullets: [
        "One row per referring domain, with the exact page the link sits on, its anchor text, the URL it points to, and whether it is followed or carries rel=nofollow, ugc or sponsored. Only followed links pass authority; the rest are mentions.",
        "Source authority is DataForSEO's 0-1000 domain rank mapped to 0-100. It is not Ahrefs DR, and it renders as a dash when unmeasured rather than dragging the average down as a zero.",
        "The index is re-read once a week inside the nightly rank cron: a site is due when its newest link is older than seven days or it has none. Check now looks it up immediately.",
        "A link is marked Lost when it was present in an earlier check and missing from the latest one. First seen is the date the index first saw it.",
      ],
    },
    {
      title: "The article exchange",
      lead:
        "The one mechanism for earning a link: another AltoRank account publishes an article that cites you, and is paid in writing rather than money.",
      bullets: [
        "You request a citation to one of your URLs. Another account can host it: they receive a full article for their own blog, on the next keyword their site should rank for, written at your expense rather than out of their monthly articles.",
        "The article arrives in the host's review queue as a draft. They can edit it, cut the citation if it does not belong, publish it, or reject it.",
        "One article costs one credit, flat, whoever publishes it. Your balance is the number of articles you have written for others minus the number you have taken. A price that rose with the host's authority would be a price on the link, so there is none.",
        "The trade settles when the article publishes, not when a link is later found: publishing is the event both sides can see.",
        "Requests you could host appear on this page only when there are some. An empty network shows nothing rather than an empty promise.",
      ],
    },
    {
      title: "What we do not do",
      lead: "Stated plainly, because most tools in this category do at least one of these.",
      bullets: [
        "No paid links and no link marketplace. Nothing here sets a price on a link or lets one be bought.",
        "No outreach. The product sends no emails to other sites on your behalf and holds no list of prospects to pitch.",
        "No network placements. A host is another real account publishing on its own site, in its own review queue, with the right to cut the citation.",
        "No guarantee that a citation survives. The host controls their article, and the link check will report it Lost if it goes.",
      ],
    },
  ],
  cannotYet: [
    "Compare your backlink profile against a competitor's.",
    "Analyse anchor-text distribution or flag over-optimised anchors.",
    "Generate a disavow file.",
    "Notify you when a link is lost. It appears under Lost on the next weekly check; nothing is emailed.",
  ],
};
