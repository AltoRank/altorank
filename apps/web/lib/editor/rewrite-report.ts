// ---------------------------------------------------------------------------
// The "what changed" report and the follow-up chips after a hunk review
// ---------------------------------------------------------------------------
//
// Two sources describe a rewrite: the model's own three bullets, and the
// hunks the reviewer actually kept. Only the second is a fact. So the report
// is built from the kept hunks first (counts by block type, per section), and
// the model's account is admitted bullet by bullet only where a kept hunk
// backs it. A bullet about a section whose blocks were all rejected is
// dropped, not softened: the article does not contain that change.
//
// The chips are the next move, read off the same kept hunks: the section
// that changed most, the one that did not change at all, the intro, the
// ending. Each is an instruction the rewrite input accepts as-is.

import { fragmentAssets } from "@/lib/ai/micro";
import { plural } from "@/lib/utils";
import { applyDecisions } from "@/lib/refresh/hunks";
import type { Hunk, HunkDecision } from "@/lib/refresh/types";

// ── Blocks and sections ─────────────────────────────────────────────────────

/** The plain-language name of a block, from its outer tag. */
export function blockNoun(html: string | null): string {
  const tag = html?.match(/^\s*<([a-zA-Z][a-zA-Z0-9]*)\b/)?.[1]?.toLowerCase() ?? "";
  if (/^h[1-6]$/.test(tag)) return "heading";
  switch (tag) {
    case "p":
      return "paragraph";
    case "ul":
    case "ol":
      return "list";
    case "table":
      return "table";
    case "blockquote":
      return "quote";
    case "img":
    case "figure":
      return "image";
    case "pre":
      return "code block";
    case "hr":
      return "divider";
    default:
      return "block";
  }
}

function textOf(html: string | null): string {
  return (html ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function isH2(html: string | null): boolean {
  return /^\s*<h2\b/i.test(html ?? "");
}

export interface HunkSection {
  /** H2 text the hunk sits under; null before the first H2 (the intro). */
  heading: string | null;
  /** Position of the section in the document, 0 = intro. */
  index: number;
}

/**
 * Which section each hunk belongs to, aligned with `hunks`. A rewritten H2
 * opens its section under its new text; a section is the H2 plus everything
 * to the next H2.
 */
export function sectionsOf(hunks: readonly Hunk[]): HunkSection[] {
  let heading: string | null = null;
  let index = 0;
  return hunks.map((h) => {
    const block = h.after ?? h.before;
    if (isH2(block)) {
      heading = textOf(block) || heading;
      index += 1;
    }
    return { heading, index };
  });
}

// ── The report ──────────────────────────────────────────────────────────────

export interface SectionSummary {
  heading: string | null;
  kept: number;
  total: number;
}

export interface ChangeReport {
  kept: number;
  total: number;
  /** From the kept hunks: "3 paragraphs rewritten", "1 list added". */
  facts: string[];
  /** Per section, only sections with at least one reviewable hunk. */
  sections: SectionSummary[];
  /** The model's bullets that a kept hunk backs. */
  notes: string[];
  /** The model's bullets set aside because nothing kept supports them. */
  droppedNotes: number;
  /** Links and images of the original all present in the result. */
  assetsIntact: boolean;
  /** Links or image sources the kept mix lost, if any. */
  missingAssets: string[];
}

const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "more", "less", "each", "every",
  "some", "than", "then", "were", "was", "are", "has", "have", "had", "not", "but", "also", "its",
  "your", "you", "our", "all", "any", "one", "two", "now", "made", "make", "kept", "keep", "same",
  "across", "throughout", "without", "while", "over", "under", "about", "after", "before",
]);

function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOP.has(w)),
  );
}

const INTRO_WORDS = /\b(intro|introduction|opening|lede|lead)\b/i;
const ENDING_WORDS = /\b(conclusion|closing|ending|wrap-?up|call to action|cta)\b/i;
const ASSET_WORDS = /\b(links?|images?|pictures?|videos?|embeds?)\b/i;

/**
 * Whether a bullet is backed by a kept hunk. Everything kept: the whole
 * account applies. Otherwise the bullet must name a section with a kept hunk
 * (by heading, or intro/ending), name a kind of block that was kept, or
 * share two content words with the kept text.
 */
function backedByKept(
  bullet: string,
  keptHunks: readonly { hunk: Hunk; section: HunkSection }[],
  sections: readonly HunkSection[],
  allKept: boolean,
): boolean {
  if (keptHunks.length === 0) return false;
  if (allKept) return true;
  const b = bullet.toLowerCase();
  const lastIndex = sections.length ? sections[sections.length - 1].index : 0;

  for (const { hunk, section } of keptHunks) {
    if (section.heading) {
      const h = section.heading.toLowerCase();
      const hw = contentWords(h);
      if (b.includes(h) || (hw.size > 0 && hw.size <= 6 && [...hw].every((w) => b.includes(w)))) return true;
    }
    if (section.index === 0 && INTRO_WORDS.test(bullet)) return true;
    if (section.index === lastIndex && lastIndex > 0 && ENDING_WORDS.test(bullet)) return true;
    const noun = blockNoun(hunk.after ?? hunk.before);
    if (noun !== "block" && noun !== "paragraph" && new RegExp(`\\b${noun}s?\\b`, "i").test(bullet)) return true;
  }

  const keptText = keptHunks.map(({ hunk }) => `${textOf(hunk.after)} ${textOf(hunk.before)}`).join(" ");
  const kw = contentWords(keptText);
  const bw = contentWords(bullet);
  let overlap = 0;
  for (const w of bw) if (kw.has(w)) overlap++;
  return overlap >= 2;
}

/**
 * The report the panel shows once the kept hunks are applied. `before` is
 * the article as sent, so the asset check runs against what the rewrite
 * started from.
 */
export function changeReport(
  hunks: readonly Hunk[],
  decisions: Record<string, HunkDecision>,
  modelChanges: readonly string[],
  before: string,
): ChangeReport {
  const sections = sectionsOf(hunks);
  const reviewable = hunks.map((hunk, i) => ({ hunk, section: sections[i] })).filter(({ hunk }) => hunk.kind !== "unchanged");
  const keptHunks = reviewable.filter(({ hunk }) => decisions[hunk.id] === "accepted");
  const kept = keptHunks.length;
  const total = reviewable.length;
  const allKept = total > 0 && kept === total;

  // Facts: counts by verb and noun, in the order rewritten → added → removed.
  const counts = new Map<string, number>();
  for (const { hunk } of keptHunks) {
    const verb = hunk.kind === "changed" ? "rewritten" : hunk.kind === "added" ? "added" : "removed";
    const key = `${verb}|${blockNoun(hunk.after ?? hunk.before)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const verbOrder = ["rewritten", "added", "removed"];
  const facts = [...counts.entries()]
    .sort((a, b) => verbOrder.indexOf(a[0].split("|")[0]) - verbOrder.indexOf(b[0].split("|")[0]) || b[1] - a[1])
    .map(([key, n]) => {
      const [verb, noun] = key.split("|");
      return `${plural(n, noun)} ${verb}`;
    });

  // Sections with something to review, in document order.
  const bySection = new Map<number, SectionSummary>();
  for (const { hunk, section } of reviewable) {
    const row = bySection.get(section.index) ?? { heading: section.heading, kept: 0, total: 0 };
    row.total += 1;
    if (decisions[hunk.id] === "accepted") row.kept += 1;
    bySection.set(section.index, row);
  }
  const sectionRows = [...bySection.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row);

  // The model's account, bullet by bullet. Claims about links and images are
  // replaced by the measured fact below, whatever the model said.
  const notes: string[] = [];
  let droppedNotes = 0;
  for (const raw of modelChanges) {
    const bullet = raw.trim();
    if (!bullet) continue;
    if (ASSET_WORDS.test(bullet) && !/\b(add|new|inserted?)\b/i.test(bullet)) {
      droppedNotes += 1;
      continue;
    }
    if (backedByKept(bullet, keptHunks, sections, allKept)) notes.push(bullet);
    else droppedNotes += 1;
  }

  // Assets: the kept mix, not the model's whole proposal, is what is checked.
  const result = applyDecisions(hunks, decisions);
  const was = fragmentAssets(before);
  const now = fragmentAssets(result);
  const missingAssets = [
    ...was.hrefs.filter((h) => !now.hrefs.includes(h)),
    ...was.srcs.filter((s) => !now.srcs.includes(s)),
  ];

  return {
    kept,
    total,
    facts,
    sections: sectionRows,
    notes,
    droppedNotes,
    assetsIntact: missingAssets.length === 0,
    missingAssets: [...new Set(missingAssets)],
  };
}

/** One line for the header of the report. */
export function reportHeadline(r: ChangeReport): string {
  if (r.total === 0) return "The rewrite proposed no changes to the article.";
  if (r.kept === 0) return "Nothing kept. The article is as it was.";
  if (r.kept === r.total) return `Applied all ${plural(r.total, "change")}.`;
  return `Applied ${r.kept} of ${plural(r.total, "change")}; the rest stays as it was.`;
}

// ── Follow-up chips ─────────────────────────────────────────────────────────

function quoteHeading(heading: string): string {
  const t = heading.length > 40 ? `${heading.slice(0, 39).trimEnd()}…` : heading;
  return `“${t}”`;
}

/**
 * Three or four next instructions, read off the kept hunks. Empty when
 * nothing was kept: there is no change to follow up on, and the panel falls
 * back to its opening chips.
 */
export function followUpChips(hunks: readonly Hunk[], decisions: Record<string, HunkDecision>): string[] {
  const sections = sectionsOf(hunks);
  const rows = hunks.map((hunk, i) => ({ hunk, section: sections[i] }));
  const kept = rows.filter(({ hunk }) => hunk.kind !== "unchanged" && decisions[hunk.id] === "accepted");
  if (kept.length === 0) return [];

  const chips: string[] = [];
  const lastIndex = sections.length ? sections[sections.length - 1].index : 0;

  // Intro.
  const introTouched = kept.some(({ section }) => section.index === 0);
  chips.push(introTouched ? "Shorten the intro even more" : "Bring the intro in line with the rewritten sections");

  // The section that changed most (by heading, so the intro is excluded).
  const keptBySection = new Map<number, { heading: string; n: number; html: string }>();
  for (const { hunk, section } of kept) {
    if (!section.heading) continue;
    const row = keptBySection.get(section.index) ?? { heading: section.heading, n: 0, html: "" };
    row.n += 1;
    row.html += hunk.after ?? "";
    keptBySection.set(section.index, row);
  }
  const busiest = [...keptBySection.values()].sort((a, b) => b.n - a.n)[0];
  if (busiest) {
    chips.push(
      /<a\b[^>]*href=/i.test(busiest.html)
        ? `Add a concrete example to ${quoteHeading(busiest.heading)}`
        : `Add a source for ${quoteHeading(busiest.heading)}`,
    );
  }

  // A section the rewrite left alone.
  const touched = new Set(kept.map(({ section }) => section.index));
  const untouched = rows.find(({ section }) => section.index > 0 && section.heading && !touched.has(section.index));
  if (untouched?.section.heading) {
    chips.push(`Apply the same treatment to ${quoteHeading(untouched.section.heading)}`);
  }

  // The ending.
  chips.push(lastIndex > 0 && !touched.has(lastIndex) ? "Add a stronger conclusion" : "Make the ending a clearer call to action");

  // Enough to reach three whatever the shape of the article.
  chips.push("Trim 15% more without losing depth", "Make it more opinionated and punchy");

  return [...new Set(chips)].slice(0, 4);
}
