// ---------------------------------------------------------------------------
// Did a draft go live on the customer's own site? The nightly check
// ---------------------------------------------------------------------------
//
// A real signup (2026-09-22, a Turkish web/mobile agency) published one of our
// drafts on their hand-coded site 48 minutes after it was written. No CMS was
// connected, so nothing went through the publish path, and the article stayed
// "in review" for ever: every internal metric counted them as never having
// used a draft, and the lifecycle emails went on treating them as idle.
// Paying customers who copy from the editor onto a site we are not connected
// to are just as invisible.
//
// So once a night (cron/site-pages, 10:00) this looks at every site with an
// unpublished draft written in the last 30 days, reads its sitemap for pages
// that are new since the draft, fetches a bounded number of them, and asks
// the one question lib/found-on-site/similarity.ts answers: is this page our
// draft's text? A match is written onto the existing publish record - status
// 'live', `published_url` the page it was found on - with `found_on_site_*`
// saying that is how it went live and how to take it back (migration 094).
//
// What it reads, and how politely:
//   - public pages only, through the SSRF-guarded fetch the public tools use
//     (lib/public-tools/safe-fetch.ts): the resolved address is checked, every
//     redirect is re-checked, bodies are capped
//   - robots.txt first, matched per RFC 9309 (lib/seo/robots.ts), as the same
//     crawler the weekly site crawl already is; a robots.txt that does not
//     answer (5xx, no response) means the site is not read at all, and a
//     Crawl-delay drops the fetch to one at a time with that pause
//   - twenty pages per site per night at most; what the cap cut is counted in
//     the run's log and read the next night
//
// A site it cannot see is not "checked". No readable sitemap, an empty one,
// a robots.txt that does not answer or forbids every page, or pages whose
// text arrives by JavaScript (below the crawl's own readable-words line) all
// mean a copy there would never be found. Each is recorded as a reason on the
// workspace (`found_on_site_unreadable`), shown in the Publish panel where
// the person copies the draft out, and raised to system_events as a warning
// the night it starts - rather than counted as a site that was looked at and
// had nothing on it.
//
// No paid call anywhere in it.

import type { SupabaseClient } from "@supabase/supabase-js";
import { safeFetch, type SafeFetch, type SafeFetchResult } from "@/lib/public-tools/safe-fetch";
import { findElements, metaMap, mapLimit, titleOf } from "@/lib/public-tools/html";
import { decode } from "@/lib/audit/html-utils";
import { tiptapToHtml } from "@/lib/cms/html";
import { CRAWLER_NAME, CRAWLER_USER_AGENT, mainContentWords, MIN_READABLE_WORDS } from "@/lib/seo/site-crawl";
import { isAllowed, loadRobots, type RobotsRules } from "@/lib/seo/robots";
import { discoverSitemapEntries } from "@/lib/seo/sitemap";
import {
  LASTMOD_SLACK_MS,
  onSite,
  PAGES_PER_WORKSPACE,
  selectCandidates,
  siteHost,
  urlKey,
  type Selection,
} from "./candidates";
import { compare, isMatch, prepareDraft, preparePage, type MatchEvidence, type PreparedDraft } from "./similarity";
import type { FoundOnSiteBlindness } from "./state";

/** Drafts older than this are not looked for. A copy happens within days, not months. */
export const LOOKBACK_DAYS = 30;

/**
 * Statuses a draft can be copied from and not yet be live. `drafting` has no
 * text yet; `live` is already published; `archived` is a person's "not this
 * one", which a find would overrule.
 */
export const CANDIDATE_STATUSES = ["draft", "review", "approved", "scheduled", "error"] as const;

const PAGE_TIMEOUT_MS = 10_000;
const PAGE_MAX_BYTES = 2_000_000;
const SITEMAP_MAX_BYTES = 5_000_000;
const ROBOTS_MAX_BYTES = 500 * 1024;
const CONCURRENCY = 4;
/** The longest Crawl-delay honoured, as in the site crawl. Longer asks run out the night's budget instead. */
const MAX_CRAWL_DELAY_MS = 5_000;

export interface FoundArticle {
  articleId: string;
  url: string;
  containment: number;
  rule: MatchEvidence["rule"];
}

export interface WorkspaceOutcome {
  workspaceId: string;
  domain: string;
  /**
   * `checked`: the site's new pages could be read and compared.
   * `unreadable`: they could not, for the reason in `blind`; not a site that
   * was looked at and had nothing on it.
   */
  status: "checked" | "unreadable" | "skipped" | "error";
  detail?: string;
  /**
   * What this visit established about whether the check can see the site:
   * a reason it cannot, null when it can, absent when the visit established
   * neither (skipped, failed, out of time).
   */
  blind?: FoundOnSiteBlindness | null;
  /** Set the night a site becomes unreadable, or its reason changes: the warning's trigger. */
  newlyUnreadable?: boolean;
  /** HTML pages read tonight whose main content was below the readable-words line. */
  shells?: number;
  drafts?: number;
  sitemapUrls?: number;
  read?: number;
  /** Pages chosen but not read: no answer, or the night's time ran out. Tried again tomorrow. */
  unread?: number;
  skipped?: Selection["skipped"];
  found?: FoundArticle[];
}

export interface FoundOnSiteRun {
  /** Sites with at least one draft to look for. */
  considered: number;
  /** Sites whose new pages were read and compared. */
  checked: number;
  /** Sites the check cannot see (no sitemap, robots.txt, JavaScript pages). Never counted in `checked`. */
  unreadable: number;
  /** Articles found live tonight. */
  found: number;
  /** Sites the night's time did not reach. First in line tomorrow. */
  deferred: number;
  results: WorkspaceOutcome[];
}

export interface RunOptions {
  /** Wall-clock budget for the whole check, every site together. */
  budgetMs: number;
  /** Injected in tests. Production is always the SSRF-guarded fetch. */
  fetch?: SafeFetch;
  now?: () => Date;
}

type DraftRow = {
  id: string;
  workspace_id: string;
  title: string;
  content: Record<string, unknown> | null;
  status: string;
  created_at: string;
  published_url: string | null;
  published_at: string | null;
  found_on_site_rejected: string[] | null;
};

/**
 * One night's check, across every site that has something to look for. Never
 * throws for one site's trouble: each outcome is reported, and a database
 * error on the initial read is the only thing that ends the run.
 */
export async function findDraftsLiveOnSites(supabase: SupabaseClient, opts: RunOptions): Promise<FoundOnSiteRun> {
  const clock = opts.now ?? (() => new Date());
  const fetch = opts.fetch ?? safeFetch;
  // Elapsed time is real time, whatever date `now` says it is: the budget is
  // this invocation's share of Vercel's 300 seconds.
  const deadline = Date.now() + opts.budgetMs;
  const since = new Date(clock().getTime() - LOOKBACK_DAYS * 86_400_000).toISOString();

  // Which sites have a draft to look for. Ids only: the drafts themselves,
  // with their bodies, are read one site at a time.
  const { data: pending, error } = await supabase
    .from("articles")
    .select("workspace_id")
    .in("status", [...CANDIDATE_STATUSES])
    .is("found_on_site_at", null)
    .not("content", "is", null)
    .gte("created_at", since);
  if (error) throw new Error(`found-on-site: could not read drafts: ${error.message}`);
  const ids = [...new Set((pending ?? []).map((r) => r.workspace_id as string))];
  const run: FoundOnSiteRun = { considered: ids.length, checked: 0, unreadable: 0, found: 0, deferred: 0, results: [] };
  if (!ids.length) return run;

  // Least recently visited first, never-visited before all, so a night that
  // runs out of time leaves the rest at the head of tomorrow's queue.
  const { data: sites, error: wsErr } = await supabase
    .from("workspaces")
    .select("id, domain, found_on_site_checked_at, found_on_site_unreadable")
    .in("id", ids)
    .not("domain", "is", null)
    .order("found_on_site_checked_at", { ascending: true, nullsFirst: true });
  if (wsErr) throw new Error(`found-on-site: could not read workspaces: ${wsErr.message}`);

  for (const ws of sites ?? []) {
    const workspaceId = ws.id as string;
    const domain = String(ws.domain);
    const previously = (ws.found_on_site_unreadable as FoundOnSiteBlindness | null | undefined) ?? null;
    if (Date.now() >= deadline) {
      run.deferred++;
      run.results.push({ workspaceId, domain, status: "skipped", detail: "out of time tonight; first in line tomorrow" });
      continue;
    }
    let outcome: WorkspaceOutcome;
    try {
      outcome = await checkWorkspace(supabase, { workspaceId, domain, since, previously }, { fetch, clock, deadline });
    } catch (err) {
      outcome = { workspaceId, domain, status: "error", detail: err instanceof Error ? err.message : String(err) };
    }
    // Stamped whatever happened, so a site that cannot be read does not stay
    // at the head of the queue and starve the others. What the visit learned
    // about whether the site can be seen is written with it; a visit that
    // learned nothing (skipped, failed) leaves the last answer standing.
    const patch: Record<string, unknown> = { found_on_site_checked_at: clock().toISOString() };
    if (outcome.blind !== undefined) {
      patch.found_on_site_unreadable = outcome.blind;
      if (outcome.blind && outcome.blind !== previously) outcome.newlyUnreadable = true;
    }
    const { error: stampErr } = await supabase.from("workspaces").update(patch).eq("id", workspaceId);
    if (stampErr) {
      // Not written means tomorrow visits it first again and repeats tonight's
      // warning; said, so a stuck queue has a reason in the log.
      outcome = {
        ...outcome,
        status: "error",
        detail: `${outcome.detail ? `${outcome.detail}; ` : ""}the visit could not be recorded on the site: ${stampErr.message}`,
      };
    }
    if (outcome.status === "checked") run.checked++;
    if (outcome.status === "unreadable") run.unreadable++;
    run.found += outcome.found?.length ?? 0;
    run.results.push(outcome);
  }
  return run;
}

interface Ctx {
  fetch: SafeFetch;
  clock: () => Date;
  deadline: number;
}

/** A page that answered. `html` only when it answered 2xx with HTML, on the site. */
interface ReadPage {
  /** The address the sitemap gave: the ledger's key, which tomorrow's selection looks up. */
  sitemapUrl: string;
  /** Where it landed after redirects: the address recorded as published_url. */
  url: string;
  lastmod: string | null;
  draftIds: string[];
  status: number;
  html: string | null;
  /** Main-content words, for an HTML page on the site; null otherwise. */
  words: number | null;
}

async function checkWorkspace(
  supabase: SupabaseClient,
  site: { workspaceId: string; domain: string; since: string; previously: FoundOnSiteBlindness | null },
  ctx: Ctx,
): Promise<WorkspaceOutcome> {
  const { workspaceId, domain } = site;
  const base: WorkspaceOutcome = { workspaceId, domain, status: "checked" };
  const blind = (reason: FoundOnSiteBlindness, detail: string, extra: Partial<WorkspaceOutcome> = {}): WorkspaceOutcome => ({
    ...base,
    ...extra,
    status: "unreadable",
    blind: reason,
    detail,
  });

  const { data: draftRows, error: draftErr } = await supabase
    .from("articles")
    .select("id, workspace_id, title, content, status, created_at, published_url, published_at, found_on_site_rejected")
    .eq("workspace_id", workspaceId)
    .in("status", [...CANDIDATE_STATUSES])
    .is("found_on_site_at", null)
    .not("content", "is", null)
    .gte("created_at", site.since);
  if (draftErr) throw new Error(`drafts: ${draftErr.message}`);
  const drafts = (draftRows ?? []) as DraftRow[];
  if (!drafts.length) return { ...base, status: "skipped", detail: "no draft to look for" };

  const host = siteHost(domain);
  const origin = `https://${domain.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "")}`;

  // Permission first. A 4xx robots.txt allows everything; a 5xx or no answer
  // allows nothing, and the site is not read tonight (RFC 9309 §2.3.1).
  const robots: RobotsRules = await loadRobots(origin, CRAWLER_NAME, async (u) => {
    const res = await ctx.fetch(u, {
      userAgent: CRAWLER_USER_AGENT,
      maxBytes: ROBOTS_MAX_BYTES,
      timeoutMs: PAGE_TIMEOUT_MS,
      headers: { Accept: "text/plain,*/*;q=0.5" },
    });
    return { status: res.status, body: res.status >= 200 && res.status < 300 ? res.body : null };
  });
  if (robots.source === "error") {
    return blind(
      "robots-unanswered",
      "robots.txt did not answer (server error or no response); a site that cannot say what it allows is not read",
      { drafts: drafts.length },
    );
  }
  const allowed = (u: string) => isAllowed(robots, u);

  const discovery = await discoverSitemapEntries(
    origin,
    async (u) => {
      const res = await ctx.fetch(u, {
        userAgent: CRAWLER_USER_AGENT,
        maxBytes: SITEMAP_MAX_BYTES,
        timeoutMs: PAGE_TIMEOUT_MS,
        headers: { Accept: "application/xml,text/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5" },
      });
      return { status: res.status, body: res.body, bytes: res.bodyBuffer };
    },
    { declared: robots.sitemaps, allowed, deadline: ctx.deadline },
  );
  if (!discovery.entries.length) {
    // The night ran out before a sitemap answered: that says nothing about
    // the site, and it is tried again tomorrow.
    if (discovery.truncated && !discovery.sitemapsRead.length) {
      return { ...base, status: "skipped", drafts: drafts.length, detail: "out of time before a sitemap was read; tried again tomorrow" };
    }
    if (discovery.sitemapsDisallowed.length) {
      return blind(
        "robots-disallowed",
        `robots.txt disallows the sitemaps it would have to read (${discovery.sitemapsDisallowed.length})`,
        { drafts: drafts.length, sitemapUrls: 0 },
      );
    }
    return discovery.sitemapsRead.length
      ? blind("empty-sitemap", "the sitemap lists no pages", { drafts: drafts.length, sitemapUrls: 0 })
      : blind(
          "no-sitemap",
          `no sitemap could be read (tried ${discovery.sitemapsFailed.length}); without one there is no list of new pages to check`,
          { drafts: drafts.length, sitemapUrls: 0 },
        );
  }

  // What is already known about the site's pages: when the weekly crawl first
  // saw each, what this check has read before, and which URLs are already an
  // article's address.
  // Read in full: a site's pages and its ledger can pass the 1,000 rows one
  // PostgREST response carries, and a silently truncated list would make old
  // pages look new. A failed read fails the site rather than guessing.
  const [known, ledger, claimed] = await Promise.all([
    allRows<{ url: string; first_seen_at: string }>("site_pages", (from, to) =>
      supabase.from("site_pages").select("url, first_seen_at").eq("workspace_id", workspaceId).order("url").range(from, to),
    ),
    allRows<{ url: string; checked_at: string }>("found_on_site_checks", (from, to) =>
      supabase.from("found_on_site_checks").select("url, checked_at").eq("workspace_id", workspaceId).order("url").range(from, to),
    ),
    allRows<{ published_url: string }>("articles", (from, to) =>
      supabase
        .from("articles")
        .select("published_url")
        .eq("workspace_id", workspaceId)
        .not("published_url", "is", null)
        .order("id")
        .range(from, to),
    ),
  ]);

  const selection = selectCandidates({
    entries: discovery.entries,
    drafts: drafts.map((d) => ({ id: d.id, createdAt: d.created_at, rejected: d.found_on_site_rejected ?? [] })),
    host,
    allowed,
    known: new Map(known.map((r) => [urlKey(r.url), r.first_seen_at])),
    ledger: new Map(ledger.map((r) => [urlKey(r.url), { checkedAt: r.checked_at }])),
    claimed: new Set(claimed.map((r) => urlKey(r.published_url))),
    limit: PAGES_PER_WORKSPACE,
  });

  // Pages on the site, but none it lets us read, or none on the site at all:
  // the sitemap is there and still shows us nothing.
  const { offSite, notContent, alreadyAnArticle, disallowed } = selection.skipped;
  const onSiteContent = discovery.entries.length - offSite - notContent - alreadyAnArticle;
  if (offSite === discovery.entries.length) {
    return blind("empty-sitemap", `the sitemap lists no pages on ${host}`, {
      drafts: drafts.length,
      sitemapUrls: discovery.entries.length,
      skipped: selection.skipped,
    });
  }
  if (onSiteContent > 0 && disallowed === onSiteContent) {
    return blind("robots-disallowed", "robots.txt disallows every page the sitemap lists", {
      drafts: drafts.length,
      sitemapUrls: discovery.entries.length,
      skipped: selection.skipped,
    });
  }

  // Read the chosen pages. A Crawl-delay is honoured by going one at a time.
  const delayMs = Math.min((robots.crawlDelaySeconds ?? 0) * 1000, MAX_CRAWL_DELAY_MS);
  const read = await mapLimit(selection.chosen, delayMs > 0 ? 1 : CONCURRENCY, async (c, i): Promise<ReadPage | null> => {
    if (Date.now() >= ctx.deadline) return null;
    if (delayMs > 0 && i > 0) await new Promise((r) => setTimeout(r, delayMs));
    let res: SafeFetchResult;
    try {
      res = await ctx.fetch(c.url, {
        userAgent: CRAWLER_USER_AGENT,
        maxBytes: PAGE_MAX_BYTES,
        timeoutMs: PAGE_TIMEOUT_MS,
        headers: { Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" },
      });
    } catch {
      return null; // no answer: not recorded, so tried again tomorrow
    }
    // A server error or a rate limit is the site not answering yet, not an
    // answer about the page: same as no answer.
    if (res.status >= 500 || res.status === 429) return null;
    // A redirect off the site (a login wall, a parked domain) is not a page of it.
    const landed = onSite(res.url, host) ? res.url : null;
    const isHtml = /html/i.test(res.headers["content-type"] ?? "");
    const html = landed && res.status >= 200 && res.status < 300 && isHtml ? res.body : null;
    return {
      sitemapUrl: c.url,
      url: landed ?? c.url,
      lastmod: c.lastmod,
      draftIds: c.draftIds,
      status: res.status,
      html,
      words: html === null ? null : mainContentWords(html),
    };
  });
  const answered = read.filter((p): p is ReadPage => p !== null);

  // Compare. Each draft is prepared once, and only against the pages that are
  // new relative to it.
  const byId = new Map(drafts.map((d) => [d.id, d]));
  const prepared = new Map<string, PreparedDraft>();
  const preparedFor = (d: DraftRow) => {
    let p = prepared.get(d.id);
    if (!p) {
      let html = "";
      try {
        html = d.content ? tiptapToHtml(d.content) : "";
      } catch {
        // A body the renderer cannot read has no text to find: it compares as
        // too short and matches nothing, and the site's other drafts go on.
      }
      p = prepareDraft(d.title, html);
      prepared.set(d.id, p);
    }
    return p;
  };
  const pairs: Array<{ page: ReadPage; draft: DraftRow; evidence: MatchEvidence }> = [];
  for (const page of answered) {
    if (!page.html) continue;
    const pagePrepared = preparePage(page.html, headlinesOf(page.html));
    for (const id of page.draftIds) {
      const draft = byId.get(id);
      if (!draft) continue;
      const evidence = compare(preparedFor(draft), pagePrepared);
      if (isMatch(evidence)) pairs.push({ page, draft, evidence });
    }
  }

  // One page is one article and one article is one page: strongest first.
  pairs.sort((a, b) => b.evidence.containment - a.evidence.containment || b.evidence.title - a.evidence.title);
  const takenPages = new Set<string>();
  const takenDrafts = new Set<string>();
  const found: FoundArticle[] = [];
  const matchedByUrl = new Map<string, string>();
  const now = ctx.clock();
  for (const { page, draft, evidence } of pairs) {
    if (takenPages.has(page.url) || takenDrafts.has(draft.id)) continue;
    const recorded = await recordFind(supabase, draft, page, evidence, now);
    if (!recorded) continue;
    takenPages.add(page.url);
    takenDrafts.add(draft.id);
    matchedByUrl.set(page.url, draft.id);
    found.push({ articleId: draft.id, url: page.url, containment: evidence.containment, rule: evidence.rule });
  }

  // The ledger: every page that answered, matched or not, so tomorrow reads
  // different ones.
  const ledgerRows = answered.map((p) => ({
    workspace_id: workspaceId,
    url: p.sitemapUrl,
    checked_at: now.toISOString(),
    lastmod: p.lastmod,
    status: p.status,
    words: p.words,
    matched_article_id: matchedByUrl.get(p.url) ?? null,
  }));
  if (ledgerRows.length) {
    const { error: ledgerErr } = await supabase
      .from("found_on_site_checks")
      .upsert(ledgerRows, { onConflict: "workspace_id,url" });
    if (ledgerErr) {
      return { ...base, status: "error", detail: `pages were read but not recorded: ${ledgerErr.message}`, found };
    }
  }

  // Could the pages be read? A page whose main content is below the crawl's
  // readable-words line is a shell: its text arrives by JavaScript, which this
  // check does not run (a browser is a paid call). Every HTML page tonight a
  // shell, and nothing found, means the site's new pages cannot be seen. At
  // least one readable page means they can. No HTML page tonight (nothing new,
  // or only 404s) says nothing new about the pages, so an earlier "JavaScript"
  // answer stands; the sitemap-level reasons above are cleared, since tonight
  // the sitemap was read.
  const html = answered.filter((p) => p.words !== null && !matchedByUrl.has(p.url));
  const shells = html.filter((p) => (p.words ?? 0) < MIN_READABLE_WORDS).length;
  const pagesBlind: FoundOnSiteBlindness | null =
    found.length === 0 && html.length > 0 && shells === html.length
      ? "javascript"
      : html.length > 0 || found.length > 0
        ? null
        : site.previously === "javascript"
          ? "javascript"
          : null;

  const outcome: WorkspaceOutcome = {
    ...base,
    drafts: drafts.length,
    sitemapUrls: discovery.entries.length,
    read: answered.length,
    unread: selection.chosen.length - answered.length,
    skipped: selection.skipped,
    shells,
    found,
    blind: pagesBlind,
    ...(discovery.truncated ? { detail: "the sitemap walk stopped at its bound; the rest is read on later nights" } : {}),
  };
  if (pagesBlind) {
    outcome.status = "unreadable";
    outcome.detail = html.length
      ? `every page read (${html.length}) had fewer than ${MIN_READABLE_WORDS} words of text without JavaScript`
      : "the pages read on an earlier night had no text without JavaScript, and none has been readable since";
  }
  return outcome;
}

/** One PostgREST response's worth of rows. */
const PAGE_ROWS = 1000;

/** Every row of a paged read, or a thrown error naming the table. */
async function allRows<T>(
  table: string,
  page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_ROWS) {
    const { data, error } = await page(from, from + PAGE_ROWS - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE_ROWS) return out;
  }
}

/** Every headline the page offers: og:title, <title>, and each H1. */
function headlinesOf(html: string): string[] {
  const og = metaMap(html).get("og:title") ?? [];
  const h1s = findElements(html, "h1").map((e) => decode(e.inner.replace(/<[^>]+>/g, " ")));
  return [...og, titleOf(html) ?? "", ...h1s].filter(Boolean);
}

/**
 * Write one find onto the article. Conditional on the article still being in
 * the state it was read in: a person who approved or published it while the
 * page was being fetched has made the newer decision, and it stands.
 */
async function recordFind(
  supabase: SupabaseClient,
  draft: DraftRow,
  page: ReadPage,
  evidence: MatchEvidence,
  now: Date,
): Promise<boolean> {
  // When it went live: the sitemap's own date when that is plausible (not
  // before the draft existed, not in the future), otherwise the moment we
  // found it, which is the latest it can have been.
  const lastmod = page.lastmod ? Date.parse(page.lastmod) : NaN;
  const created = Date.parse(draft.created_at);
  const publishedAt =
    Number.isFinite(lastmod) && lastmod >= created && lastmod <= now.getTime() ? page.lastmod! : now.toISOString();

  const { data, error } = await supabase
    .from("articles")
    .update({
      status: "live",
      published_url: page.url,
      published_at: publishedAt,
      found_on_site_at: now.toISOString(),
      found_on_site_evidence: {
        ...evidence,
        url: page.url,
        lastmod: page.lastmod,
        // Whether the lastmod was used as the publish date or only recorded.
        lastmodTrusted: publishedAt === page.lastmod,
        slackHours: LASTMOD_SLACK_MS / 3_600_000,
      },
      found_on_site_prior: {
        status: draft.status,
        published_url: draft.published_url,
        published_at: draft.published_at,
      },
    })
    .eq("id", draft.id)
    .eq("status", draft.status)
    .is("found_on_site_at", null)
    .select("id");
  if (error) throw new Error(`recording ${draft.id}: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}
