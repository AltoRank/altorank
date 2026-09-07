import type { Explainer } from "./types";
import { FREE_DRAFTS } from "@/lib/billing/quota";

/**
 * Read from: app/actions/publish.ts (approveArticle, requestChanges,
 * unpublishArticle), app/actions/schedule.ts (scheduleArticle),
 * lib/publishing/core.ts (the gate), app/api/cron/publish/route.ts and
 * vercel.json (when it runs), components/dashboard/article-row-menu.tsx
 * (what a status flip can and cannot set), lib/cms/types.ts (no update on
 * the adapter interface).
 */
export const reviewExplainer: Explainer = {
  id: "review",
  title: "Review and approval",
  intro:
    "One gate, enforced in code rather than by convention: nothing reaches a site without a person's approval on record.",
  mountsAt: "app/(dashboard)/articles/page.tsx, PageHead actions (this track).",
  sections: [
    {
      title: "The gate",
      lead:
        "Every draft, whoever or whatever wrote it, waits in Review until someone approves it.",
      bullets: [
        "Drafts from the scheduler, from New article and from a hand-made article all land with the status In review.",
        "Approve records who approved and when. It is the only path to Approved: the row menu's status change offers Draft and Review and nothing else.",
        "Approving re-runs the fact check on what is in the editor at that moment. A bare figure with no source blocks approval until it is sourced or cut; a named but unverified source is left to your judgement, which is what review is for.",
        "Request changes sends an approved article back to Review and clears the sign-off, so it must be approved again before it can go anywhere.",
        `On the hosted free tier, approving and publishing ask you to choose a plan. Reading, editing and rewriting the month's ${FREE_DRAFTS} free drafts do not.`,
      ],
    },
    {
      title: "What Publish does",
      lead:
        "Publish sends an approved article through the site's connected CMS and records where it went.",
      bullets: [
        "It publishes through the site's connection, or the one you pick when several are connected, sets the article Live and stores the URL and external id it came back with.",
        "Schedule needs Approved first. A scheduled article publishes when its date passes, or, without a date, on the site's cadence days at or after the set time, one per day.",
        "The publish cron runs every hour (Vercel at 09:00 UTC, GitHub Actions the other hours) and only touches articles that are Approved, or Scheduled with a recorded approval. Rows scheduled before approval existed are refused.",
        "After publishing, the URL is submitted to IndexNow and, when Search Console is connected, to Google. A git-based publish waits until the built page is live before telling anyone.",
        "Every attempt, manual or cron, success or failure, is written to the publish log.",
      ],
    },
    {
      title: "What never happens",
      lead: "Nothing reaches a CMS without an approval recorded under a named person. There is no path around that one.",
      bullets: [
        "Every publish carries an `approved_by`. The publish core refuses any other status, and the button and the cron both go through it.",
        "Two things can write that approval, and only two: a person pressing Approve, or the publishing rule a member turned on for the workspace, which waits out a hold window and re-runs the same source, audit and plan checks before it signs off as that member. Held drafts say why on their own row. Nothing else, including an agent, can write one.",
        "The generator writes into Review and has no publish step of its own.",
        "A raw status change cannot make an article Approved, Scheduled or Live; those states are reached only through their own actions.",
        "Unpublish takes the post down in the CMS, clears the published URL, and returns the article to Review.",
      ],
    },
  ],
  cannotYet: [
    // Was: "Update a post that is already live in the CMS. Adapters publish
    // and unpublish; publishing again creates a new post. In-place edits
    // arrive with the WordPress plugin (#71)." All three sentences had gone
    // stale - the publish core calls adapter.update() when the adapter has
    // one and refuses a second create when it does not, six adapters
    // implement update, and the plugin adapter is registered. Narrowed to
    // what is still true rather than deleted (2026-09-06).
    "Update a post already live on Shopify, Magento, Framer, Wix, Notion, HubSpot or WooCommerce. WordPress, the WordPress plugin, Ghost, Webflow, a webhook and git edit in place; the rest have no update call, so a re-publish is refused rather than duplicated.",
    "Require a second reviewer, or approve on someone else's behalf.",
    "Publish from the Articles list for a site with no CMS connected. The editor's copy-and-record path is the route there.",
    "Show who requested changes, or why. The sign-off is cleared; the reason is not stored.",
  ],
};
