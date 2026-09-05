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
  woocommerce: "Saved as a draft post. Publish it from the WordPress admin.",
  "wordpress-plugin": "Saved as a draft post through the AltoRank plugin. Publish it from the WordPress admin.",
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
    'The payload carries publishMode: "draft". Your endpoint decides what that means.',
  git:
    "Committed with draft: true in the front matter. Your site's build has to honour that field.",
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
