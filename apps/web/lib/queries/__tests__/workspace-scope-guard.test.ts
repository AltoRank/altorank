/**
 * The half a unit test cannot reach.
 *
 * Two of the seven scope bugs fixed on 2026-09-03 lived inside server
 * components - the dashboard's Search Console count and the Backlinks nav gate
 * - which are not callable from vitest. So this walks the source instead and
 * fails when a read against a workspace-scoped table has no workspace filter.
 *
 * It is a lint rule wearing a test's clothes, and it is deliberately crude: it
 * reads the `.from("table")` chain as text and asks whether `workspace_id`
 * appears in it. That is enough, because the failure it guards against is
 * exactly an absent `.eq("workspace_id", …)`.
 *
 * Adding to ALLOWED is a normal thing to do - plenty of reads are account-wide
 * on purpose. Write the reason next to it. An entry that stops matching also
 * fails the test, so the list cannot rot into a pile of stale excuses.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Tables carrying a `workspace_id` column (schema as of 2026-09-04). */
const SCOPED_TABLES = new Set([
  "analytics_metrics",
  "articles",
  "backlinks",
  "calendar_entries",
  "domain_audits",
  "generation_jobs",
  "geo_prompts",
  "geo_results",
  "keywords",
  "keyword_research_runs",
  "link_sources",
  "link_targets",
  "provider_spend",
  "publish_log",
  "publishing_cadences",
  "refresh_candidates",
  "refresh_executions",
  "refresh_tasks",
  "reports",
  "voice_profiles",
  "workspace_integrations",
  "workspace_metrics",
]);

/**
 * Reads that are account-wide on purpose.
 *
 * Key is `path:table`; value is why. Crons and sync jobs run for every
 * workspace by definition - they are the thing that fills these tables - and
 * `lib/queries` functions take an optional workspace so a caller without a
 * scope (operator views) still sees the account.
 */
const ALLOWED: Record<string, string> = {
  "app/api/cron/publish/route.ts:publishing_cadences":
    "the scheduler reads every workspace's cadence, then publishes per workspace - " +
    "scoping it would mean only one site ever gets published",
  "app/api/cron/analytics/route.ts:workspace_integrations":
    "the sync walks every connected workspace; that walk is the job",
  "lib/content/generate.ts:articles":
    "generation resolves its article by id first (and checks workspace_id when " +
    "it does); the later writes address that same row",
};

const ROOT = join(__dirname, "..", "..", "..");
const SEARCH_DIRS = ["app", "lib", "components"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

type Finding = { key: string; file: string; line: number; table: string };

function findUnscopedReads(): Finding[] {
  const found: Finding[] = [];

  for (const dir of SEARCH_DIRS) {
    for (const file of walk(join(ROOT, dir))) {
      const src = readFileSync(file, "utf8");
      const rel = relative(ROOT, file);

      for (const m of src.matchAll(/\.from\(\s*["'`](\w+)["'`]\s*\)/g)) {
        const table = m[1];
        if (!SCOPED_TABLES.has(table)) continue;
        // `supabase.storage.from("reports")` is a bucket, not the table that
        // happens to share its name.
        if (/\bstorage\s*$/.test(src.slice(Math.max(0, m.index! - 40), m.index!))) continue;

        // How much text counts as "this query".
        //
        // Not a character window: one `update({...})` in generate.ts carries a
        // 900-character payload that pushed its own `.eq("id", …)` out of
        // view. Not the statement either - the dominant pattern here is
        //
        //     let query = supabase.from("keywords").select("*");
        //     if (workspaceId) query = query.eq("workspace_id", workspaceId);
        //
        // where the filter lands in the *next* statement. So: a window of
        // lines, wide enough for both, stopping at the next `.from(`.
        const CHAIN_LINES = 22;
        const after = src.slice(m.index! + m[0].length);
        let chain = after.split("\n").slice(0, CHAIN_LINES).join("\n");
        const next = chain.indexOf(".from(");
        if (next !== -1) chain = chain.slice(0, next);

        if (chain.includes("workspace_id") || chain.includes("workspaceId")) continue;
        // An insert needs no filter: the row it writes carries its own
        // `workspace_id`, and whether that value is right is the caller's
        // business, not a question about scope.
        if (/^\s*\.(insert|upsert)\(/.test(chain)) continue;
        // Addressed by primary key - one row, or an explicit list of ids,
        // both already resolved by a scoped query upstream.
        if (/\.(eq|in)\(\s*["']id["']/.test(chain) || chain.includes(".single()")) continue;

        found.push({
          key: `${rel}:${table}`,
          file: rel,
          line: src.slice(0, m.index).split("\n").length,
          table,
        });
      }
    }
  }
  return found;
}

describe("no new unscoped reads of workspace-scoped tables", () => {
  const findings = findUnscopedReads();

  it("every unscoped read is one we decided to allow", () => {
    const unexplained = findings.filter((f) => !(f.key in ALLOWED));

    // The message is the point: whoever trips this is reading it at 2am.
    const detail = unexplained
      .map((f) => `  ${f.file}:${f.line} reads "${f.table}" with no workspace filter`)
      .join("\n");

    expect(
      unexplained.length,
      unexplained.length === 0
        ? ""
        : `\n${detail}\n\n` +
            `RLS scopes these to the signed-in AGENCY, not to one workspace, so an\n` +
            `unscoped read returns every site in the account and never errors. On an\n` +
            `account with one site it looks correct, which is how seven of these\n` +
            `reached production on 2026-09-03.\n\n` +
            `Either add .eq("workspace_id", scopeId) - the scope comes from\n` +
            `getScopedWorkspaceId() on the server or useWorkspace().active on the\n` +
            `client - or, if the read really is account-wide, add it to ALLOWED in\n` +
            `this file with the reason.\n`,
    ).toBe(0);
  });

  it("every allowance still corresponds to real code", () => {
    // Stops the list becoming a graveyard: a fixed or deleted read must be
    // removed from ALLOWED, or nobody can tell which entries still mean
    // anything.
    const live = new Set(findings.map((f) => f.key));
    const stale = Object.keys(ALLOWED).filter((k) => !live.has(k));

    expect(
      stale.length,
      stale.length === 0
        ? ""
        : `\nThese ALLOWED entries no longer match any unscoped read:\n` +
            stale.map((s) => `  ${s}`).join("\n") +
            `\n\nThe read was scoped or removed. Delete the entry.\n`,
    ).toBe(0);
  });
});

/**
 * Query helpers that take a workspace as their scope argument, and which
 * argument it is (0-based).
 *
 * The raw-`.from()` rule above cannot see these: the badge bug of 2026-09-03
 * was `getArticles()` called with nothing at all, inside a helper that scopes
 * correctly when you give it something. The chain looked perfect - the caller
 * just never said which site.
 */
const SCOPED_HELPERS: Record<string, number> = {
  getArticles: 0,
  getRecentArticles: 1,
  getKeywords: 0,
  getPlannerKeywords: 0,
  getKeywordSourceYields: 0,
  getBacklinks: 0,
  getReports: 0,
  getGeoPrompts: 0,
  getLatestGeoResults: 0,
  loadGscRows: 0,
  syncHealthFor: 0,
  knownPagesFor: 0,
  getTrafficValue: 0,
  getArticleValue: 1,
  getBingSummary: 0,
  getCalendarEntries: 0,
};

/** Call sites allowed to ask for the whole account. */
const ALLOWED_UNSCOPED_CALLS: Record<string, string> = {
  "app/(dashboard)/admin": "operator views are account-wide by definition",
  "app/(dashboard)/workspaces/page.tsx":
    "the all-sites list: it counts articles per workspace, so it needs them all",
};

type CallFinding = { file: string; line: number; fn: string };

function findUnscopedHelperCalls(): CallFinding[] {
  const found: CallFinding[] = [];
  // Only pages and components render for one site. Crons and lib code call
  // these helpers deliberately unscoped.
  for (const dir of ["app/(dashboard)", "components"]) {
    let files: string[];
    try {
      files = walk(join(ROOT, dir));
    } catch {
      continue;
    }
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const rel = relative(ROOT, file);
      if (Object.keys(ALLOWED_UNSCOPED_CALLS).some((prefix) => rel.startsWith(prefix))) continue;

      for (const [fn, argIndex] of Object.entries(SCOPED_HELPERS)) {
        for (const m of src.matchAll(new RegExp(`\\b${fn}\\(([^()]*)\\)`, "g"))) {
          // Skip the import line and the definition itself.
          const lineStart = src.lastIndexOf("\n", m.index!) + 1;
          const line = src.slice(lineStart, src.indexOf("\n", m.index!));
          if (/^\s*(import|export|async function|function)/.test(line)) continue;

          // Any argument counts. The question is whether the call names a
          // site at all, not whether the variable holding it is well named -
          // `getArticles(id)` on the workspace detail page is perfectly
          // scoped, and an earlier version of this rule flagged it for the
          // crime of being called `id`.
          const args = m[1].split(",").map((a) => a.trim()).filter(Boolean);
          const arg = args[argIndex];
          if (arg !== undefined && arg !== "undefined") continue;

          found.push({
            file: rel,
            line: src.slice(0, m.index).split("\n").length,
            fn,
          });
        }
      }
    }
  }
  return found;
}

describe("scoped query helpers are called with a workspace", () => {
  it("no page or component asks a scoped helper for the whole account", () => {
    const findings = findUnscopedHelperCalls();
    const detail = findings
      .map((f) => `  ${f.file}:${f.line} calls ${f.fn}() with no workspace`)
      .join("\n");

    expect(
      findings.length,
      findings.length === 0
        ? ""
        : `\n${detail}\n\n` +
            `These helpers scope correctly when given a workspace and return the whole\n` +
            `account when not. A page that omits the argument renders another site's\n` +
            `rows under this site's heading - which is exactly how the sidebar came to\n` +
            `read "4" beside a list of 2 on 2026-09-03.\n\n` +
            `Pass getScopedWorkspaceId() (server) or useWorkspace().active (client).\n`,
    ).toBe(0);
  });
});
