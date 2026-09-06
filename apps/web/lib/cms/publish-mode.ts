// ---------------------------------------------------------------------------
// Publishing behaviour: draft or live, per connection
// ---------------------------------------------------------------------------
//
// Every adapter used to publish live, unconditionally. For an agency handing a
// client "one-click publishing" that is the wrong default: a draft the client
// releases from their own CMS is recoverable, a post that went live at 03:00
// with a wrong image is not. So a connection carries a publish_mode, chosen in
// the connect dialog, defaulting to draft.
//
// What "draft" means differs per platform, and one platform cannot express it
// at all without help. This module is the one place that knows which, so the
// dialog, the server action and the tests agree - and so that when a platform
// cannot save a draft the dialog says so, rather than the adapter quietly
// publishing live.

import type { CMSConfig } from "@/lib/types";
import type { PublishMode } from "./types";

export type { PublishMode };

export const PUBLISH_MODES: readonly PublishMode[] = ["draft", "publish"];

/** New connections save drafts unless told otherwise. */
export const DEFAULT_PUBLISH_MODE: PublishMode = "draft";

export function isPublishMode(value: unknown): value is PublishMode {
  return value === "draft" || value === "publish";
}

/**
 * How each platform expresses a draft, in words the dialog can show beside the
 * option. Present for every type: a platform missing from here is a platform
 * the dialog has no story for, and TypeScript says so.
 */
export const DRAFT_BEHAVIOUR: Record<CMSConfig["type"], string> = {
  wordpress: "Saved as a draft post. Publish it from the WordPress admin.",
  "wordpress-plugin": "Saved as a draft post. Publish it from the WordPress admin.",
  woocommerce: "Saved as a draft post. Publish it from the WordPress admin.",
  ghost: "Saved as a draft. Publish it from the Ghost admin.",
  webflow:
    "Staged as a draft item in the collection; the site is not republished.",
  shopify: "Saved as a hidden (unpublished) blog article.",
  wix: "Left as a draft post in the Wix blog.",
  notion:
    "The Status property you name below is set to the draft option. Notion pages have no publish state of their own.",
  hubspot: "Saved as a draft blog post.",
  framer: "Saved as a draft collection item.",
  magento: "Saved as a disabled CMS page.",
  webhook:
    'The payload carries publish_mode: "draft". Your endpoint decides what that means.',
  git:
    "Committed with draft: true in the front matter. Your site's build has to honour that field.",
};

/**
 * What "publish live" actually does, per platform, in words the dialog can
 * show beside the option.
 *
 * The dialog used to print one generic sentence for all thirteen: "The article
 * is public on {CMS} the moment you press Publish, or the schedule fires."
 * That is false for two of them, and this codebase says so elsewhere. A git
 * publish is a commit, not a deploy - lib/publishing/core.ts returns
 * `indexnow: "awaiting-build"` and the publish cron budgets two hours for the
 * URL to appear. And the WordPress plugin decides for itself: its own "post as
 * draft" setting wins over this radio (wordpress-plugin.ts sends whatever the
 * plugin asks for), which is why the note above the radio already warns about
 * it.
 */
export const LIVE_BEHAVIOUR: Record<CMSConfig["type"], string> = {
  wordpress: "Published as a public post the moment you press Publish.",
  "wordpress-plugin":
    "Sent as a published post - but the plugin decides: if its own setting says post as drafts, the article arrives as a draft anyway.",
  woocommerce: "Published as a public post the moment you press Publish.",
  ghost: "Published the moment you press Publish.",
  webflow:
    "The item is created and the collection is published, so it is live as soon as Webflow's publish finishes.",
  shopify: "Visible on the storefront the moment you press Publish.",
  wix: "Created as a draft post and published in a second call, so it is live when both return.",
  notion:
    "The page is added to the database, with the Status property set to the published option when one is named. A Notion page is visible to whoever the database is shared with; there is no public state of its own.",
  hubspot: "Published the moment you press Publish.",
  framer:
    "The item is created without the draft flag. This connector has not been exercised against a live Framer project.",
  magento: "Created as an enabled CMS page, public at /your-slug.",
  webhook:
    'The payload carries publish_mode: "publish". Your endpoint decides what that means.',
  git:
    "Committed to the branch. Your host still has to build and deploy, so the URL does not resolve yet - the publish cron confirms it afterwards, over about two hours before it gives up.",
};

/**
 * Whether this connector's test proves the credentials can write.
 *
 * Eleven of the thirteen tests are a GET or a list. The dialog said "Test
 * passed. {CMS} answered. Press Connect to save.", which reads as proof that
 * publishing will work - and a Subscriber-role application password or a
 * read_content-only Shopify app passes it, saves, and 403s on the first
 * publish. Only the WordPress plugin (which creates and deletes a real draft)
 * and the webhook (which delivers a test payload) exercise a write.
 */
export const TEST_PROVES: Record<CMSConfig["type"], "write" | "read"> = {
  wordpress: "read",
  "wordpress-plugin": "write",
  woocommerce: "read",
  ghost: "read",
  webflow: "read",
  shopify: "read",
  wix: "read",
  notion: "read",
  hubspot: "read",
  framer: "read",
  magento: "read",
  webhook: "write",
  git: "read",
};

/**
 * Whether this connection can save a draft, and if not, why.
 *
 * Almost every platform can. Notion is the exception: a page in a database
 * has no draft state, only whatever properties the database defines, so a
 * draft is only expressible when the config names a Status property to set.
 * Refusing here - and in the dialog, before anything is saved - is the whole
 * point: the alternative is an adapter that publishes live while the
 * connection says draft.
 */
export function draftSupport(
  config: Pick<CMSConfig, "type"> & Partial<CMSConfig>,
): { ok: true } | { ok: false; reason: string } {
  if (config.type === "notion") {
    const prop = (config as { statusProperty?: string }).statusProperty?.trim();
    if (!prop) {
      return {
        ok: false,
        reason:
          "This destination cannot save drafts: Notion pages have no draft state. Name a Status property on the database, or choose to publish live.",
      };
    }
  }
  return { ok: true };
}

/**
 * The check the connect action runs before storing. Throws so a connection
 * that claims a mode it cannot honour never reaches the table.
 */
export function assertPublishMode(config: CMSConfig, mode: PublishMode): void {
  if (mode !== "draft") return;
  const support = draftSupport(config);
  if (!support.ok) throw new Error(support.reason);
}

/** The label a Publish button wears for this mode. */
export function publishVerb(mode: PublishMode | undefined, label: string): string {
  return mode === "draft" ? `Save draft to ${label}` : `Publish to ${label}`;
}
