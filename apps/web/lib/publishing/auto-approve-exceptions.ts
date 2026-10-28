// ---------------------------------------------------------------------------
// Exception rules: the drafts a person sees under autopilot
// ---------------------------------------------------------------------------
//
// Autopilot ships a draft that passes its checks after the hold window. A
// person is asked only when one of these fires (Wave 1, B4, decisions D1-D10
// accepted 2026-10-16):
//
//   first_draft       nothing on this site was ever approved or went live, so
//                     the voice and the audience are calibrated once
//   sensitive         health, legal, financial or safety advice
//                     (sensitiveTopicOf, lib/content/trust.ts)
//   price             a currency amount the site's own pages never state
//   competitor        a rival the business profile names
//   page_type         an article type and subtype never published live here
//   publish_failures  this site's last two publishes failed
//
// The facts are computed by the loader (runAutoApprovals) and decided by the
// pure `decideAutoApproval`; everything here is pure too, so each rule is a
// table row in a test.
//
// Opt-outs live in `workspaces.auto_approve_exceptions` (migration 119), a
// map of rule to `false`, written by the server only. Only the four rules D5
// lets a site turn off can be turned off; first draft, the fact check and
// failures are always on. "sensitive" also needs CLEAN_APPROVALS_FOR_SENSITIVE
// approvals that went out unedited before its opt-out counts.

import { foldCase, foldMarks, type SensitiveKind } from "@/lib/i18n/locale";
import { brandFromDomain } from "@/lib/keyword-research/seeds";
import { stripTags, decode } from "@/lib/content/enrich/html";

/** The rules a site may turn off. */
export const OPT_OUT_RULES = ["sensitive", "price", "competitor", "page_type"] as const;
export type OptOutRule = (typeof OPT_OUT_RULES)[number];

/** D5: health, legal and money advice stays with a person until the site has this many. */
export const CLEAN_APPROVALS_FOR_SENSITIVE = 5;

/** What the switches say. One place, so the form and the refusal agree. */
export const OPT_OUT_LABELS: Record<OptOutRule, { title: string; detail: string }> = {
  sensitive: { title: "Health, legal or money advice", detail: `Can be turned off after ${CLEAN_APPROVALS_FOR_SENSITIVE} approvals that went out unedited` },
  price: { title: "A price or offer that is not on your site", detail: "Checked against the pages we read on your site" },
  competitor: { title: "A competitor is named", detail: "The competitors in your business profile" },
  page_type: { title: "A page type this site has never published", detail: "A comparison, a roundup, a how-to" },
};

/**
 * The rules this site turned off, from the stored column. Anything that is
 * not a known rule set to exactly `false` is ignored, so a malformed value
 * keeps every rule on.
 */
export function optedOut(raw: unknown): Set<OptOutRule> {
  const out = new Set<OptOutRule>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const rule of OPT_OUT_RULES) {
    if ((raw as Record<string, unknown>)[rule] === false) out.add(rule);
  }
  return out;
}

/**
 * Whether a rule is off for this site right now. "sensitive" is off only
 * while the site has the clean approvals D5 asks for; below that the stored
 * opt-out is kept but not honoured.
 */
export function ruleIsOff(rule: OptOutRule, optOuts: ReadonlySet<OptOutRule>, cleanApprovals: number): boolean {
  if (!optOuts.has(rule)) return false;
  return rule !== "sensitive" || cleanApprovals >= CLEAN_APPROVALS_FOR_SENSITIVE;
}

/** The facts the exception rules read, computed per draft by the loader. */
export type ExceptionFacts = {
  /** No article on this workspace was ever approved or went live. */
  firstDraftOnSite: boolean;
  /** From sensitiveTopicOf; null when the topic is not health, legal, financial or safety. */
  sensitive: { kind: SensitiveKind; evidence: string } | null;
  /** Currency amounts in the body that none of the site's known pages state. */
  pricesNotOnSite: readonly string[];
  /** Rivals from the business profile the body names or links to. */
  competitorsNamed: readonly string[];
  /** The draft's page type, when this workspace has never had one live. */
  newPageType: string | null;
  /** Set when the last two publishes on this site failed; the newest error. */
  failedPublishes: { lastError: string | null } | null;
  /** Human approvals on this site that went live with no person edit before they went out. */
  cleanApprovals: number;
};

// ── Page type ────────────────────────────────────────────────────────────────

/** "listicle · roundup", "guide · howTo", "guide"; null when the draft has no type. */
export function pageTypeOf(type: string | null | undefined, subtype: string | null | undefined): string | null {
  if (!type) return null;
  return subtype ? `${type} · ${subtype}` : type;
}

// ── Prices ───────────────────────────────────────────────────────────────────

const NUMBER = /\d(?:[\d.,]*\d)?/g;

/**
 * The amount a figure states, with its separators read: "€1.500,50" and
 * "$1,500.50" are both 1500.5, "£45" is 45. A trailing one or two digits
 * after the last separator are decimals; any other separator groups.
 */
export function amountOf(figure: string): number | null {
  const m = figure.match(/\d(?:[\d.,]*\d)?/);
  if (!m) return null;
  const raw = m[0];
  const dec = raw.match(/[.,](\d{1,2})$/);
  const whole = (dec ? raw.slice(0, -dec[0].length) : raw).replace(/[.,]/g, "");
  const n = Number(dec ? `${whole}.${dec[1]}` : whole);
  return Number.isFinite(n) ? n : null;
}

/** Every amount the site's own text states, as numbers. */
export function amountsIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(NUMBER)) {
    const n = amountOf(m[0]);
    if (n != null) out.add(n);
  }
  return out;
}

/**
 * Currency figures in the draft (the fact check's `money` claims) whose
 * amount appears nowhere in the site's own text. Lenient on purpose: any
 * number on the site that equals the amount clears it, because the rule is
 * "a price the business never stated", not "a price in a different format".
 */
export function pricesNotOnSite(moneyFigures: readonly string[], siteAmounts: ReadonlySet<number>): string[] {
  const out: string[] = [];
  for (const f of moneyFigures) {
    const n = amountOf(f);
    if (n == null || siteAmounts.has(n)) continue;
    if (!out.includes(f)) out.push(f);
  }
  return out;
}

// ── Competitors ──────────────────────────────────────────────────────────────

function words(text: string): string {
  return ` ${foldMarks(foldCase(text)).replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "ltd", "plc"]);

/**
 * The spellings of one rival worth looking for in a draft: its host
 * ("rival-physio.co.uk") and its name without the TLD ("rival-physio" reads
 * as "rival physio"). Not brandAliases' suffix-trimmed head: "physioagency"
 * trimmed to "physio" would match every article a physio site writes.
 */
function rivalSpellings(rival: string): string[] {
  const host = brandFromDomain(rival);
  if (!host.includes(".")) return [rival.trim()].filter((n) => n.length >= 3);
  const parts = host.split(".").slice(0, -1);
  // "rival.co.uk" is called "rival", not "rival co".
  if (parts.length > 1 && SECOND_LEVEL.has(parts[parts.length - 1])) parts.pop();
  const label = parts.join(".");
  return [...new Set([host, label])].filter((n) => n.length >= 3);
}

/**
 * Whether consecutive words of the text spell `compact` with the spaces
 * taken out: "North Beans" names northbeans.co.uk, "Rival Physio" names
 * rivalphysio.com. Two words at least, so a single word is still matched
 * only whole, above.
 */
function runsInto(tokens: readonly string[], compact: string): boolean {
  for (let i = 0; i < tokens.length; i++) {
    let run = tokens[i];
    for (let j = i + 1; j < tokens.length && run.length < compact.length; j++) {
      run += tokens[j];
      if (run === compact) return true;
    }
  }
  return false;
}

/**
 * The rivals a draft names, by host, by name, or by a link to their site.
 * `competitors` are domains (business_profile.competitors), `names` are the
 * rivals the owner named without one (competitorNames). A one-word spelling
 * that is also a word of the draft's own keyword is skipped: a rival called
 * "seo.com" is not named by every article about SEO.
 */
export function competitorsNamed(input: {
  html: string;
  keyword: string | null;
  competitors: readonly string[];
  names?: readonly string[];
}): string[] {
  const text = words(decode(stripTags(input.html)));
  const tokens = text.trim().split(" ");
  const keyword = words(input.keyword ?? "");
  const hrefs = [...input.html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1].toLowerCase());
  const out: string[] = [];
  const consider = (rival: string, spellings: string[]) => {
    const host = brandFromDomain(rival);
    const linked = host.includes(".") && hrefs.some((h) => {
      try {
        const linkHost = new URL(h).hostname.replace(/^www\./, "");
        return linkHost === host || linkHost.endsWith(`.${host}`);
      } catch {
        return false;
      }
    });
    const named = spellings.some((s) => {
      const w = words(s);
      if (w.trim().split(" ").length === 1 && keyword.includes(w)) return false;
      return w.trim().length >= 3 && (text.includes(w) || runsInto(tokens, w.replace(/ /g, "")));
    });
    if ((linked || named) && !out.includes(rival)) out.push(rival);
  };
  for (const c of input.competitors) consider(c, rivalSpellings(c));
  for (const n of input.names ?? []) consider(n, [n].filter((x) => x.trim().length >= 3));
  return out;
}

// ── Clean approvals ──────────────────────────────────────────────────────────

export type ApprovalRow = {
  status: string;
  approval_kind: string | null;
  approved_at: string | null;
  published_at: string | null;
  person_edited_at: string | null;
};

/**
 * D5's "approvals that went out unedited": a person approved it, it went
 * live, and no person saved its text before it went out. An edit after it
 * went live changes nothing about the approval. A row approved before
 * migration 119 carries `-infinity` (edits were not recorded) and so is not
 * counted.
 */
export function isCleanApproval(a: ApprovalRow): boolean {
  if (a.status !== "live" || a.approval_kind !== "human" || !a.approved_at) return false;
  if (!a.person_edited_at) return true;
  const edited = Date.parse(a.person_edited_at);
  const out = Date.parse(a.published_at ?? a.approved_at);
  return Number.isFinite(edited) && Number.isFinite(out) && edited > out;
}
