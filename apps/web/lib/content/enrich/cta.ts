// ---------------------------------------------------------------------------
// Step 6: closing call to action
// ---------------------------------------------------------------------------
//
// One heading, one sentence, one link to the site the article is written for.
// It offers the configured next destination, without asserting that a draft
// has already been published. No offer, no price, no "book a free demo" - none of that is
// known here, and inventing it is exactly the fabricated-fact failure this
// product exists to prevent.

import { labelsFor } from "./labels";
import { normaliseDomain } from "@/lib/seo/links";
import { escapeHtml, escapeAttr, slugify } from "./html";
import { decodeEntities } from "@/lib/audit/html-utils";

export interface CtaOptions {
  /** `workspace_output_settings.call_to_action`; defaults on. */
  enabled?: boolean;
  /** The workspace domain. Without one there is nowhere to point. */
  domain?: string | null;
  /** `business_profile.name` when onboarding captured it. */
  businessName?: string | null;
  conversionUrl?: string | null;
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
  let url = `https://${host}`;
  try {
    const target = new URL(opts.conversionUrl ?? "");
    if (/^https?:$/.test(target.protocol) && normaliseDomain(target.hostname) === host && !target.username && !target.password) url = target.href;
  } catch { /* An absent or invalid destination falls back to the known homepage. */ }

  // The writer may already finish with the selected next step. Preserve that
  // natural ending instead of appending a second heading and the same link.
  const closingParagraph = [...html.matchAll(/<p\b[^>]*>[\s\S]*?<\/p>/gi)].at(-1)?.[0] ?? "";
  const targetKey = (value: string) => {
    try { const parsed = new URL(decodeEntities(value)); parsed.hash = ""; return parsed.href.replace(/\/$/, ""); }
    catch { return null; }
  };
  if ([...closingParagraph.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["']/gi)].some(match => targetKey(match[1]) === targetKey(url))) return {html,added:false};

  const section =
    `<section class="cta">` +
    `<h2 id="${slugify(labels.learnMore(name))}">${escapeHtml(labels.learnMore(name))}</h2>` +
    `<p>${escapeHtml(labels.visit)} ` +
    `<a href="${escapeAttr(url)}">${escapeHtml(host)}</a>.</p>` +
    `</section>`;

  return { html: `${html.replace(/\s+$/, "")}\n${section}\n`, added: true };
}
