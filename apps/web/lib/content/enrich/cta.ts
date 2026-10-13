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
//
// Where it points is what the site facts verified (lib/content/site-facts.ts):
// the business's own page for the article's topic, and its conversion page -
// a page that answered, or a phone number or email the owner saved. A
// physiotherapy clinic's first article (2026-09-27) closed on its homepage
// while its profile held the clinic's phone number and the crawl had read its
// pages for both services the article compared. The homepage is the link
// only when nothing better was verified.

import { resolveLocale } from "@/lib/i18n/locale";
import { normaliseDomain } from "@/lib/seo/links";
import { conversionLinkText } from "@/lib/content/topic-pages";
import { escapeHtml, escapeAttr, slugify } from "./html";

export interface CtaOptions {
  /** `workspace_output_settings.call_to_action`; defaults on. */
  enabled?: boolean;
  /** The workspace domain. Without one there is nowhere to point. */
  domain?: string | null;
  /** `business_profile.name` when onboarding captured it. */
  businessName?: string | null;
  language?: string | null;
  /** The verified conversion URL: a page that answered, or a `tel:` / `mailto:` the owner saved. */
  conversion?: string | null;
  /** The business's own page for this article's topic, fetched by the crawl. */
  service?: { name: string; url: string } | null;
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
  // Each label is a sentence with a hole for the link, because where the
  // link goes is grammar: "Visit example.com." but "example.com adresini
  // ziyaret edin." The text around the hole is escaped; the link is built here.
  const sentence = (label: string, href: string, text: string) => {
    const [before, after = ""] = label.split("{link}");
    return `${escapeHtml(before)}<a href="${escapeAttr(href)}">${escapeHtml(text)}</a>${escapeHtml(after)}`;
  };
  const conversion = opts.conversion?.trim() || null;
  const parts = [
    escapeHtml(labels.publishedBy(name)),
    opts.service ? sentence(labels.citeLead, opts.service.url, opts.service.name) : null,
    conversion
      ? sentence(labels.contact, conversion, conversionLinkText(conversion))
      : sentence(labels.visit, `https://${host}`, host),
  ].filter(Boolean);

  const section =
    `<section class="cta">` +
    `<h2 id="${slugify(labels.learnMore(name))}">${escapeHtml(labels.learnMore(name))}</h2>` +
    `<p>${parts.join(" ")}</p>` +
    `</section>`;

  return { html: `${html.replace(/\s+$/, "")}\n${section}\n`, added: true };
}
