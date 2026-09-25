// ---------------------------------------------------------------------------
// Step 6: closing call to action
// ---------------------------------------------------------------------------
//
// One heading, one sentence, one link to the site the article is written for.
// It says only what is known to be true: who publishes the piece and where to
// find them. No offer, no price, no "book a free demo" - none of that is
// known here, and inventing it is exactly the fabricated-fact failure this
// product exists to prevent.
//
// Every word of it is a label from the locale contract, so in a language the
// contract does not describe there is no call to action at all: an English
// "Learn more about… / This article is published by…" closed the Turkish
// draft of 2026-09-22, and an omitted section is better than a foreign one.

import { resolveLocale } from "@/lib/i18n/locale";
import { normaliseDomain } from "@/lib/seo/links";
import { escapeHtml, escapeAttr, slugify } from "./html";

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
  const locale = resolveLocale(opts.language);
  if (!locale.supported) return { html, added: false };

  const labels = locale.labels;
  const name = opts.businessName?.trim() || host;
  const url = `https://${host}`;
  // `visit` is a sentence with a hole for the link, because where the link
  // goes is grammar: "Visit example.com." but "example.com adresini ziyaret
  // edin." The text around the hole is escaped; the link is built here.
  const link = `<a href="${escapeAttr(url)}">${escapeHtml(host)}</a>`;
  const [beforeLink, afterLink = ""] = labels.visit.split("{link}");

  const section =
    `<section class="cta">` +
    `<h2 id="${slugify(labels.learnMore(name))}">${escapeHtml(labels.learnMore(name))}</h2>` +
    `<p>${escapeHtml(labels.publishedBy(name))} ${escapeHtml(beforeLink)}${link}${escapeHtml(afterLink)}</p>` +
    `</section>`;

  return { html: `${html.replace(/\s+$/, "")}\n${section}\n`, added: true };
}
