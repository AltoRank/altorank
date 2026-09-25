// ---------------------------------------------------------------------------
// Article audit: what a draft is missing, as a list a reviewer can act on
// ---------------------------------------------------------------------------
//
// The two scorers answer "how good is this number". This answers "what do I
// fix", which is a different question and needs a different shape: not a
// weighted aggregate but named findings, each with the fragments of text it
// refers to, so the editor can jump to them.
//
// It covers the ground the scorers leave uncovered. `scoring.ts` counts any
// link that is not YouTube, Wikipedia or a social network as internal, so a
// citation to hubspot.com passes the internal-link check and a bare `#`
// counts as a link. `aeo-scoring.ts` counts every absolute URL as an outbound
// citation, including the site's own. Neither knows the site's domain, so
// neither can tell inside from outside. This one is told, and classifies by
// it.
//
// Deliberately no model call and no network: it runs on every keystroke in
// the editor, so it has to be a pure function of the HTML and a few facts
// about the article. What it cannot know it says it cannot know: whether a
// cited URL resolves, whether a source says what the text claims. Those are
// listed as things a person still has to check, not scored as if a machine
// had.
//
// Nor can it read a language nobody described to it. Figures, attributions,
// appeals to evidence, first-hand markers and alt-text length are language,
// and come from the locale contract (lib/i18n/locale); labels it recognises
// (a FAQ heading, "click here", a byline) are matched in every language the
// contract describes. For an article in any other language those items are
// `info` and say "not checked for <language>" - never a pass computed with
// English rules, which is what a Turkish draft got on 2026-09-22.

import { findFigures } from "./aeo-scoring";
import { findAttribution } from "@/lib/ai/fact-check";
import { checkInlineCitations } from "@/lib/ai/inline-citations";
import { findWeakAltText, MIN_ALT_WORDS, minAltWords } from "@/lib/ai/alt-text";
import { decodeEntities } from "@/lib/audit/html-utils";
import { extractLinks, hostOf, normaliseDomain, type LinkRef, isKnownPage } from "./links";
import {
  resolveLocale,
  notCheckedFor,
  matchesAnyHeading,
  anyLanguageLabels,
  supportedLocales,
  findLowered,
  foldCase,
  scaleWords,
  urlSlug,
} from "@/lib/i18n/locale";
import type { LinkCheck } from "./link-check";

// The link classifier moved to ./links so the scorers can share it without
// importing this module (which imports one of them). Re-exported so existing
// callers and tests keep their import path.
export { classifyHref, extractLinks } from "./links";
export type { LinkKind, LinkRef } from "./links";

export type AuditStatus = "fail" | "warn" | "pass" | "info";
export type AuditGroup = "links" | "sources" | "structure" | "metadata" | "media" | "trust";

export interface AuditItem {
  id: string;
  group: AuditGroup;
  status: AuditStatus;
  label: string;
  detail: string;
  /** Text fragments in the document the reviewer can jump to. */
  locate?: string[];
}

export interface ArticleAuditInput {
  html: string;
  keyword: string;
  /** The workspace domain, so a link can be told inside from outside. */
  siteDomain?: string | null;
  title?: string | null;
  metaDescription?: string | null;
  slug?: string | null;
  featuredImageUrl?: string | null;
  /**
   * How many live articles this site has to link to. Zero changes the
   * verdict on internal links from "missing" to "nothing to point at yet",
   * which is a different problem with a different fix. Undefined when the
   * caller does not know.
   */
  linkableArticles?: number | null;
  /**
   * The pages of this site a link may point at: the link pool the draft was
   * offered (configured targets, live articles, crawled pages). Given, an
   * internal link to any other URL is a link to a page nobody has seen, and
   * the internal-links item fails on it. Undefined when the caller does not
   * know what exists, in which case links are counted by domain only.
   */
  knownPages?: readonly { url: string }[] | null;
  /**
   * What each outbound link answered when the draft was generated, from
   * `articles.link_checks`. Turns "not verified" into a count of what was.
   */
  linkChecks?: LinkCheck[] | null;
  /**
   * Whether `keyword` is the term the page actually targets, or our guess.
   *
   * `guessed` when it was inferred from a slug or heading by the site crawl,
   * because nobody told us. The three checks that ask where the keyword
   * appears - in a subheading, in the opening paragraph, in the meta
   * description - are exact-phrase tests, and an inferred multi-word phrase
   * cannot pass them: it is the headline, so it will not also be inside its
   * own H2. On fitsuite.co that produced 40 failures out of 40 pages, none of
   * which a person could act on, because the fix would be "insert this phrase
   * we made up". So they are not run at all on a guess, and the panel says
   * why rather than showing a pass nobody earned.
   */
  keywordConfidence?: "known" | "guessed";
  /**
   * `workspaces.language`. The items that read prose use its rules; in a
   * language the locale contract does not describe they report "not checked".
   */
  language?: string | null;
}

export interface ArticleAudit {
  items: AuditItem[];
  links: LinkRef[];
  counts: Record<AuditStatus, number>;
  verdict: "ready" | "review" | "needs-work";
}

export const GROUP_LABEL: Record<AuditGroup, string> = {
  links: "Links",
  sources: "Sources",
  structure: "Structure",
  metadata: "Metadata",
  media: "Media",
  trust: "Trust signals",
};

// ── HTML helpers ────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function blocks(html: string, tag: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  return [...html.matchAll(re)].map((m) => m[1]);
}

function hasExternalLink(block: string, siteDomain: string | null): boolean {
  return extractLinks(block, siteDomain).some((l) => l.kind === "external");
}

/**
 * Anchor text a reader learns nothing from and a crawler learns nothing from,
 * in every language the locale contract describes.
 */
const GENERIC_ANCHORS = anyLanguageLabels("genericAnchors");

/** A byline in any described language: "Written by", "Yazar:". */
function hasByline(text: string): boolean {
  return supportedLocales().some((l) => l.prose.byline.test(l.lower(text)));
}

// ── The audit ───────────────────────────────────────────────────────────────

export function auditArticle(input: ArticleAuditInput): ArticleAudit {
  const html = input.html ?? "";
  const locale = resolveLocale(input.language);
  const notChecked = notCheckedFor(locale);
  const keyword = (input.keyword ?? "").trim();
  // Folded, not lowered: "API" lowers to "apı" in Turkish and then matched
  // no keyword (see `foldCase`).
  const kw = foldCase(keyword);
  const siteDomain = normaliseDomain(input.siteDomain);
  const items: AuditItem[] = [];
  const push = (item: AuditItem) => items.push(item);

  const text = stripHtml(html);
  const wordCount = text ? text.split(/\s+/).length : 0;
  const links = extractLinks(html, siteDomain);
  const internal = links.filter((l) => l.kind === "internal");
  const external = links.filter((l) => l.kind === "external");
  const dead = links.filter((l) => l.kind === "dead");
  const placeholders = links.filter((l) => l.kind === "placeholder");
  const inPage = links.filter((l) => l.kind === "anchor" && l.href.startsWith("#"));

  // ── Links ────────────────────────────────────────────────────────────────

  // A link to this domain is not a link to a page. Given the pool, the ones
  // that point at nothing we know are named and fail the item: the first
  // example.com draft had four such links and this read "4 internal links,
  // pass" while the editor panel beside it flagged every one.
  const unknownInternal = input.knownPages
    ? internal.filter((l) => !isKnownPage(l.href, siteDomain, input.knownPages!))
    : [];

  if (input.linkableArticles === 0 && internal.length === 0) {
    push({
      id: "internal-links",
      group: "links",
      status: "info",
      label: "Internal links",
      detail:
        "None, and nothing to point at yet: this site has no other live article. " +
        "Internal links arrive once there is something live to link to.",
    });
  } else if (unknownInternal.length) {
    const paths = [...new Set(unknownInternal.map((l) => l.href))].slice(0, 4).join(", ");
    push({
      id: "internal-links",
      group: "links",
      status: "fail",
      label: "Internal links",
      detail:
        `${unknownInternal.length} of ${internal.length} internal ${internal.length === 1 ? "link points" : "links point"} at ${unknownInternal.length === 1 ? "a page" : "pages"} not in this site's link pool (${paths}). ` +
        "A link to a page nobody has seen publishes as a 404 on the customer's own domain. Check each exists, or unlink the words.",
      locate: unknownInternal.map((l) => l.anchor).filter(Boolean).slice(0, 6),
    });
  } else {
    push({
      id: "internal-links",
      group: "links",
      status: internal.length >= 2 ? "pass" : internal.length === 1 ? "warn" : "fail",
      label: "Internal links",
      detail:
        internal.length === 0
          ? "No links to other pages on this site. A page that points at nothing hands on none of its authority and gives a crawler no path onwards."
          : internal.length === 1
            ? "One internal link. Two or three, to pages on the same subject, is the usual floor."
            : `${internal.length} internal links.`,
      locate: internal.map((l) => l.anchor).filter(Boolean).slice(0, 6),
    });
  }

  const externalDomains = [...new Set(external.map((l) => hostOf(l.href)).filter(Boolean))];
  push({
    id: "external-links",
    group: "links",
    status: external.length >= 2 ? "pass" : external.length === 1 ? "warn" : "fail",
    label: "Outbound links",
    detail:
      external.length === 0
        ? "No links out. A page that cites nothing gives a reader no way to check it, and an answer engine no reason to trust it over the twenty pages that do."
        : external.length === 1
          ? `One outbound link, to ${externalDomains[0] ?? "one domain"}. Two or more sources is the floor for a researched piece.`
          : `${external.length} outbound links across ${externalDomains.length} ${externalDomains.length === 1 ? "domain" : "domains"}.`,
    locate: external.map((l) => l.anchor).filter(Boolean).slice(0, 6),
  });

  push({
    id: "dead-links",
    group: "links",
    status: dead.length ? "fail" : "pass",
    label: "Dead links",
    detail: dead.length
      ? `${dead.length} ${dead.length === 1 ? "link goes" : "links go"} nowhere (href="#" or empty). Point each at a real page or unlink the text: published, these are 404s to a crawler and a wasted click to a reader.`
      : "Every link has a destination.",
    locate: dead.map((l) => l.anchor).filter(Boolean).slice(0, 6),
  });

  if (placeholders.length) {
    push({
      id: "placeholder-links",
      group: "links",
      status: "fail",
      label: "Unresolved link placeholders",
      detail: `${placeholders.length} internal-link ${placeholders.length === 1 ? "placeholder" : "placeholders"} the resolver never replaced. Published as-is, the href is literal template text.`,
      locate: placeholders.map((l) => l.anchor).filter(Boolean).slice(0, 6),
    });
  }

  const generic = links.filter(
    (l) => (l.kind === "internal" || l.kind === "external") && GENERIC_ANCHORS.has(foldCase(l.anchor).replace(/[.!]$/, "")),
  );
  if (internal.length + external.length > 0) {
    push({
      id: "anchor-text",
      group: "links",
      // A generic anchor found is a finding in any language; none found is
      // only a pass where we know what generic looks like.
      status: generic.length ? "warn" : locale.supported ? "pass" : "info",
      label: "Anchor text",
      detail: generic.length
        ? `${generic.length} ${generic.length === 1 ? "link uses" : "links use"} anchor text that says nothing about the destination (${[...new Set(generic.map((l) => `"${l.anchor}"`))].slice(0, 3).join(", ")}). The words inside the link are what tell a crawler what the target is about.`
        : locale.supported
          ? "Anchor text describes where each link goes."
          : notChecked,
      locate: generic.map((l) => l.anchor).slice(0, 6),
    });
  }

  // ── Sources ──────────────────────────────────────────────────────────────

  const proseBlocks = [...blocks(html, "p"), ...blocks(html, "li")];
  const unsourcedFigures: string[] = [];
  const unlinkedNames: string[] = [];
  const hollowAppeals: string[] = [];
  let attributionsSeen = 0;
  let figuresSeen = 0;

  for (const block of proseBlocks) {
    const plain = stripHtml(block);
    if (!plain) continue;
    const cites = hasExternalLink(block, siteDomain);

    const figures = findFigures(plain, locale.code);
    figuresSeen += figures.length;
    if (figures.length && !cites) unsourcedFigures.push(...figures);

    const name = findAttribution(plain, locale.code);
    if (name) {
      attributionsSeen++;
      if (!cites) unlinkedNames.push(name);
    }

    if (!cites && locale.supported) {
      hollowAppeals.push(...findLowered(locale.prose.hollowEvidence, plain, locale));
    }
  }

  push({
    id: "unsourced-figures",
    group: "sources",
    status: !locale.supported ? "info" : unsourcedFigures.length ? "fail" : figuresSeen ? "pass" : "info",
    label: "Figures with a linked source",
    detail: !locale.supported
      ? notChecked
      : unsourcedFigures.length
      ? `${unsourcedFigures.length} ${unsourcedFigures.length === 1 ? "figure sits" : "figures sit"} in a passage with no source link. Link the source in the same paragraph, or cut the number.`
      : figuresSeen
        ? `All ${figuresSeen} figures sit in a passage that links a source.`
        : "No figures in the text, so nothing to source. Specifics are what get quoted; consider whether the topic has any.",
    locate: [...new Set(unsourcedFigures)].slice(0, 8),
  });

  push({
    id: "named-sources",
    group: "sources",
    status: !locale.supported ? "info" : unlinkedNames.length ? "warn" : attributionsSeen ? "pass" : "info",
    label: "Named sources are linked",
    detail: !locale.supported
      ? notChecked
      : unlinkedNames.length
      ? `${unlinkedNames.length} ${unlinkedNames.length === 1 ? "source is" : "sources are"} named but not linked (${[...new Set(unlinkedNames)].slice(0, 3).join(", ")}). A name a reader cannot click is a claim they cannot check.`
      : attributionsSeen
        ? "Every named source carries a link."
        : 'Nothing is attributed. "According to X", with X linked, is what makes a passage citable by name.',
    locate: [...new Set(unlinkedNames)].slice(0, 6),
  });

  push({
    id: "hollow-evidence",
    group: "sources",
    status: !locale.supported ? "info" : hollowAppeals.length ? "warn" : "pass",
    label: "Appeals to unnamed evidence",
    detail: !locale.supported
      ? notChecked
      : hollowAppeals.length
      ? `${hollowAppeals.length} ${hollowAppeals.length === 1 ? "phrase appeals" : "phrases appeal"} to studies, experts or data without naming or linking any. Name the study or make the point without the appeal.`
      : "No \"studies show\" without a study.",
    locate: [...new Set(hollowAppeals)].slice(0, 6),
  });

  // A citation only in a "Sources" list at the end is evidence detached from
  // its claim. The check is on the footer, not on the body: `unsourced-figures`
  // above already says which passages cite nothing. Only worth a line when
  // there is a footer, or outbound links whose placement can be praised.
  const citations = checkInlineCitations(html, siteDomain);
  // A footer is recognised by its label, in any described language. Finding
  // none in an article whose language has no described labels proves nothing.
  if (!citations.footer && !locale.supported && external.length) {
    push({
      id: "inline-citations",
      group: "sources",
      status: "info",
      label: "Sources linked at the claim",
      detail: `${notChecked} A "Sources" list at the end is recognised by its heading.`,
    });
  } else if (citations.footer || external.length) {
    const orphaned = citations.orphaned;
    const listed = citations.footerUrls.length;
    push({
      id: "inline-citations",
      group: "sources",
      status: orphaned.length ? "fail" : "pass",
      label: "Sources linked at the claim",
      detail: orphaned.length
        ? `${orphaned.length} of ${listed} ${listed === 1 ? "URL" : "URLs"} in the "${citations.footer?.label}" list ${orphaned.length === 1 ? "is" : "are"} linked nowhere else. A source that lives only in a footer is evidence a reader never reaches and an answer engine never quotes: link each one inside the sentence it supports, then the list can stay or go.`
        : citations.footer
          ? `Every URL in the "${citations.footer.label}" list is also linked inline where the claim is made.`
          : "Sources are linked in the sentences that make the claims; no citation list at the end.",
      locate: orphaned.map((r) => r.anchor).slice(0, 6),
    });
  }

  if (external.length) {
    const checks = input.linkChecks ?? [];
    if (checks.length) {
      const answered = checks.filter((c) => c.ok).length;
      const removed = checks.filter((c) => c.removed);
      const unknown = checks.filter((c) => !c.ok && !c.removed);
      const anchorFor = (url: string) => external.find((l) => l.href === url)?.anchor ?? "";
      const reasons = [...new Set(unknown.map((c) => c.reason ?? "no answer"))].slice(0, 3).join(", ");
      push({
        id: "sources-verified",
        group: "sources",
        status: unknown.length ? "warn" : "pass",
        label: "Sources checked at generation",
        detail:
          `${answered} of ${checks.length} cited ${checks.length === 1 ? "URL" : "URLs"} answered when the draft was generated` +
          (removed.length ? `; ${removed.length} dead ${removed.length === 1 ? "link was" : "links were"} removed` : "") +
          (unknown.length
            ? `; ${unknown.length} could not be reached (${reasons}) and ${unknown.length === 1 ? "needs" : "need"} opening by hand`
            : "") +
          ". Whether each page says what the text claims is still yours to confirm.",
        locate: unknown.map((c) => anchorFor(c.url)).filter(Boolean).slice(0, 6),
      });
    } else {
      push({
        id: "sources-unverified",
        group: "sources",
        status: "info",
        label: "Sources not verified",
        detail: `${external.length} outbound ${external.length === 1 ? "link has" : "links have"} not been opened by anything here. A URL the writer produced may not resolve, and a page that exists may not say what the text says it does. Open each before approving.`,
      });
    }
  }

  // ── Structure ────────────────────────────────────────────────────────────

  const headings = [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => ({
    level: Number(m[1]),
    text: stripHtml(m[2]),
  }));
  const h1s = headings.filter((h) => h.level === 1);
  const h2s = headings.filter((h) => h.level === 2);
  const subheads = headings.filter((h) => h.level === 2 || h.level === 3);

  push({
    id: "single-h1",
    group: "structure",
    status: h1s.length === 1 ? "pass" : "fail",
    label: "One H1",
    detail:
      h1s.length === 1
        ? "Exactly one H1."
        : h1s.length === 0
          ? "No H1. The title of the page is the first thing a crawler reads."
          : `${h1s.length} H1s. A page has one title; demote the rest to H2.`,
    locate: h1s.length > 1 ? h1s.slice(1).map((h) => h.text) : undefined,
  });

  const skips: string[] = [];
  let prev = 0;
  for (const h of headings) {
    if (prev && h.level > prev + 1) skips.push(h.text);
    if (!prev && h.level > 2) skips.push(h.text);
    prev = h.level;
  }
  push({
    id: "heading-hierarchy",
    group: "structure",
    status: skips.length ? "warn" : "pass",
    label: "Heading levels step down in order",
    detail: skips.length
      ? `${skips.length} ${skips.length === 1 ? "heading skips" : "headings skip"} a level (an H4 under an H2, or an H3 before any H2). Outlines that skip levels are harder for a crawler to read as a tree.`
      : "No skipped levels in the outline.",
    locate: skips.slice(0, 6),
  });

  const keywordKnown = (input.keywordConfidence ?? "known") === "known";

  if (kw && !keywordKnown) {
    push({
      id: "keyword-placement",
      group: "structure",
      status: "info",
      label: "Keyword placement not checked",
      detail: `Nothing told us what this page targets, so "${keyword}" was inferred from its URL. Where a keyword appears is only worth measuring against the real one; connect Search Console or run a rank check and these become answerable.`,
    });
  }

  if (kw && keywordKnown) {
    push({
      id: "keyword-in-subheading",
      group: "structure",
      status: subheads.some((h) => foldCase(h.text).includes(kw)) ? "pass" : "warn",
      label: "Keyword in a subheading",
      detail: subheads.some((h) => foldCase(h.text).includes(kw))
        ? "The keyword appears in at least one H2 or H3."
        : `"${keyword}" appears in no H2 or H3. One subheading that names the subject the way it is searched is cheap and usually natural.`,
    });

    const afterH1 = html.split(/<\/h1>/i)[1] ?? html;
    const lead = blocks(afterH1, "p").map(stripHtml).find((p) => p.length > 40) ?? "";
    push({
      id: "keyword-in-intro",
      group: "structure",
      status: foldCase(lead).includes(kw) ? "pass" : "warn",
      label: "Keyword in the opening paragraph",
      detail: foldCase(lead).includes(kw)
        ? "The opening paragraph names the subject."
        : `The opening paragraph does not contain "${keyword}". The first hundred words are what decide whether the page matches the query.`,
    });
  }

  const questionHeads = subheads.filter((h) => h.text.trim().endsWith("?"));
  const faqHead = headings.some((h) => matchesAnyHeading("faq", h.text));
  push({
    id: "faq-section",
    group: "structure",
    status: faqHead || questionHeads.length >= 3 ? "pass" : "info",
    label: "FAQ section",
    detail:
      faqHead || questionHeads.length >= 3
        ? "Has a FAQ-shaped section: question headings with answers under them, which FAQ structured data is built from."
        : locale.supported
          ? "No FAQ section. Three or more question headings with a short answer under each is the shape FAQ rich results and answer engines both lift from."
          : `Fewer than three question headings. ${notChecked} A FAQ heading is recognised by its wording.`,
  });

  if (h2s.length >= 6) {
    push({
      id: "table-of-contents",
      group: "structure",
      status: inPage.length >= 3 ? "pass" : "info",
      label: "Table of contents",
      detail:
        inPage.length >= 3
          ? "Has in-page anchors a reader can jump by."
          : `${h2s.length} sections and no table of contents. Long pieces read better with one, and its anchors give Google jump links in the result.`,
    });
  }

  // ── Metadata ─────────────────────────────────────────────────────────────

  const title = (input.title ?? "").trim();
  push({
    id: "title-length",
    group: "metadata",
    status: !title ? "fail" : title.length > 60 || title.length < 30 ? "warn" : "pass",
    label: "Title length",
    detail: !title
      ? "No title."
      : title.length > 60
        ? `${title.length} characters. Google truncates titles around 60, so the end of this one will not show in results.`
        : title.length < 30
          ? `${title.length} characters. Short titles leave room unused; 50 to 60 is the usual target.`
          : `${title.length} characters, within the 30 to 60 range that displays whole.`,
  });

  const meta = (input.metaDescription ?? "").trim();
  const metaIssues: string[] = [];
  if (meta) {
    if (meta.length < 120) metaIssues.push(`${meta.length} characters is short; 120 to 160 fills the snippet`);
    if (meta.length > 160) metaIssues.push(`${meta.length} characters will be truncated around 160`);
    // Same reasoning as the placement checks: only meaningful against a
    // keyword somebody actually chose.
    if (kw && keywordKnown && !foldCase(meta).includes(kw)) {
      metaIssues.push("it does not contain the keyword, which Google bolds when it matches the query");
    }
  }
  push({
    id: "meta-description",
    group: "metadata",
    status: !meta ? "fail" : metaIssues.length ? "warn" : "pass",
    label: "Meta description",
    detail: !meta
      ? "No meta description. Google writes its own from the page, and it is rarely the sentence you would pick."
      : metaIssues.length
        ? `Present, but ${metaIssues.join("; ")}.`
        : `${meta.length} characters, keyword included.`,
  });

  const slug = (input.slug ?? "").trim();
  if (slug) {
    const slugWords = slug.split("-").filter(Boolean);
    // The same fold as the slug itself, so a Turkish keyword ("yazılım")
    // is compared as "yazilim", not "yaz-l-m".
    const kwSlug = urlSlug(keyword);
    const slugIssues: string[] = [];
    if (slug.length > 75 || slugWords.length > 8) slugIssues.push(`${slugWords.length} words and ${slug.length} characters is long for a URL`);
    if (kwSlug && !slug.includes(kwSlug)) slugIssues.push("it does not contain the keyword");
    push({
      id: "slug",
      group: "metadata",
      status: slugIssues.length ? "warn" : "pass",
      label: "URL slug",
      detail: slugIssues.length
        ? `/${slug}: ${slugIssues.join("; ")}. Slugs are generated from the title and are worth trimming by hand.`
        : `/${slug} is short and contains the keyword.`,
    });
  }

  // ── Media ────────────────────────────────────────────────────────────────

  push({
    id: "featured-image",
    group: "media",
    status: input.featuredImageUrl ? "pass" : "warn",
    label: "Featured image",
    detail: input.featuredImageUrl
      ? "Has a featured image."
      : "No featured image. Themes, social previews and Discover cards all want one; without it the share looks unfinished.",
  });

  const imgs = [...html.matchAll(/<img\b([^>]*)>/gi)].map((m) => m[1]);
  const noAlt = imgs.filter((attrs) => {
    const alt = attrs.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    return !alt || !(alt[1] ?? alt[2] ?? "").trim();
  });
  // "Long" is 1,200 English words, in this language's words; a language
  // without described word counts is never called long.
  const long = locale.supported && wordCount >= scaleWords(1200, locale);
  push({
    id: "body-images",
    group: "media",
    status: imgs.length ? "pass" : long ? "warn" : "info",
    label: "Images in the body",
    detail: imgs.length
      ? `${imgs.length} ${imgs.length === 1 ? "image" : "images"} in the body.`
      : `${long ? `${wordCount.toLocaleString()} words and no image. ` : "No images in the body. "}A screenshot, chart or diagram breaks up the text and can rank in image results on its own.`,
  });
  if (imgs.length) {
    push({
      id: "image-alt",
      group: "media",
      status: noAlt.length ? "fail" : "pass",
      label: "Image alt text",
      detail: noAlt.length
        ? `${noAlt.length} of ${imgs.length} images have no alt text. Alt text is how a crawler and a screen reader know what the image shows.`
        : "Every image has alt text.",
    });

    // Having alt text and having useful alt text are different findings. The
    // keyword on its own, or a two-word label, passes the check above and
    // describes nothing; the prompt asks for a sentence and this is the
    // check that it got one.
    const withAlt = imgs.length - noAlt.length;
    if (withAlt > 0) {
      const weak = findWeakAltText(html, keyword, locale.code).filter((f) => f.problem !== "missing");
      const keywordOnly = weak.filter((f) => f.problem === "keyword").length;
      const short = weak.filter((f) => f.problem === "short").length;
      const minWords = locale.supported ? minAltWords(locale) : MIN_ALT_WORDS;
      const reasons = [
        keywordOnly ? `${keywordOnly} ${keywordOnly === 1 ? "repeats" : "repeat"} the keyword and nothing else` : "",
        short ? `${short} ${short === 1 ? "is" : "are"} under ${minWords} words` : "",
      ].filter(Boolean);
      push({
        id: "image-alt-descriptive",
        group: "media",
        status: weak.length ? "warn" : locale.supported ? "pass" : "info",
        label: "Alt text describes the image",
        detail: weak.length
          ? `${weak.length} of ${withAlt} alt ${withAlt === 1 ? "text" : "texts"} ${weak.length === 1 ? "does" : "do"} not describe the image: ${reasons.join("; ")}. Alt text is a sentence about what the picture shows ("Bar chart comparing the monthly price of five email tools"), not a label and not the keyword.`
          : locale.supported
            ? `Every alt text is a descriptive sentence of ${minWords} words or more.`
            : `No alt text is the keyword alone. ${notChecked}`,
        locate: weak.map((f) => f.alt).slice(0, 6),
      });
    }
  }

  // ── Trust ────────────────────────────────────────────────────────────────

  const bylined = hasByline(text);
  push({
    id: "author",
    group: "trust",
    status: bylined ? "pass" : "info",
    label: "Author",
    detail: bylined
      ? "Names an author in the body."
      : "No author or byline in the body. The generator does not write one. Make sure the CMS attributes the piece to a real person with a bio; anonymous pages are the weakest E-E-A-T position there is.",
  });

  const hasExperience = locale.supported && locale.prose.firstHand.test(locale.lower(text));
  push({
    id: "first-hand",
    group: "trust",
    status: hasExperience ? "pass" : "info",
    label: "First-hand experience",
    detail: hasExperience
      ? "Contains first-hand experience markers (\"we tested\", \"in our experience\")."
      : !locale.supported
        ? notChecked
        : "Nothing in the text says the writer used, tested or ran any of this. Experience is the first E in E-E-A-T, and a single honest sentence of it is worth more than another paragraph of overview.",
  });

  push({
    id: "structured-data",
    group: "trust",
    status: "info",
    label: "Structured data",
    detail: "The editor holds prose only, so Article and FAQ JSON-LD are not in this document. They have to come from the CMS template or the publishing adapter; check the published page, not the draft.",
  });

  // ── Roll-up ──────────────────────────────────────────────────────────────

  const counts: Record<AuditStatus, number> = { fail: 0, warn: 0, pass: 0, info: 0 };
  for (const item of items) counts[item.status]++;

  return { items, links, counts, verdict: rollUp(counts) };
}

/**
 * How the findings become one word at the top of the panel.
 *
 * The audit does not gate publishing; the approval button does, and a human
 * presses it. So this is advice, not a lock, and the thresholds are a
 * judgement about what a reviewer should stop for. One failing item is enough
 * to say "needs work" because every fail here is a concrete defect a reader
 * or crawler will hit: a dead link, a missing H1, a figure with no source.
 * Warnings alone say "review": worth a look, not worth blocking on.
 */
export function rollUp(counts: Record<AuditStatus, number>): ArticleAudit["verdict"] {
  if (counts.fail > 0) return "needs-work";
  if (counts.warn > 0) return "review";
  return "ready";
}
