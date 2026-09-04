// ---------------------------------------------------------------------------
// Step 6: closing call to action
// ---------------------------------------------------------------------------
//
// One heading, one sentence, one link to the site the article is written for.
// It says only what is known to be true: who publishes the piece and where to
// find them. No offer, no price, no "book a free demo" - none of that is
// known here, and inventing it is exactly the fabricated-fact failure this
// product exists to prevent.

import { labelsFor } from "./labels";
import { normaliseDomain } from "@/lib/seo/links";
import { escapeHtml, escapeAttr } from "./html";

export interface CtaOptions {
  /** `workspace_output_settings.call_to_action`; defaults on. */
  enabled?: boolean;
  /** The workspace domain. Without one there is nowhere to point. */
  domain?: string | null;
  /** `business_profile.name` when onboarding captured it. */
  businessName?: string | null;
  language?: string | null;
}

export function hasCallToAction(html: string): boolean {
  return /<section\b[^>]*class=["'][^"']*\bcta\b/i.test(html);
}

export function addCallToAction(html: string, opts: CtaOptions = {}): { html: string; added: boolean } {
  if (opts.enabled === false) return { html, added: false };
  if (hasCallToAction(html)) return { html, added: false };
  const host = normaliseDomain(opts.domain);
  if (!host) return { html, added: false };

  const labels = labelsFor(opts.language);
  const name = opts.businessName?.trim() || host;
  const url = `https://${host}`;

  const section =
    `<section class="cta">` +
    `<h2>${escapeHtml(labels.learnMore(name))}</h2>` +
    `<p>${escapeHtml(labels.publishedBy(name))} ${escapeHtml(labels.visit)} ` +
    `<a href="${escapeAttr(url)}">${escapeHtml(host)}</a>.</p>` +
    `</section>`;

  return { html: `${html.replace(/\s+$/, "")}\n${section}\n`, added: true };
}
