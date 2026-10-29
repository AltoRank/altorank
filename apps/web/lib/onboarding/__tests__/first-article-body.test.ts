import { describe, expect, it } from "vitest";
import { fullArticleOn, readableHtml, readFirstArticleBody, readFirstArticleProgress } from "../first-article-body";

describe("the gate's full-article reader", () => {
  it("is on by default: unset or 1 is on, 0 (or anything else) is off", () => {
    expect(fullArticleOn({})).toBe(true);
    expect(fullArticleOn({ PRETRIAL_FULL_ARTICLE: "" })).toBe(true);
    expect(fullArticleOn({ PRETRIAL_FULL_ARTICLE: "1" })).toBe(true);
    expect(fullArticleOn({ PRETRIAL_FULL_ARTICLE: "0" })).toBe(false);
    expect(fullArticleOn({ PRETRIAL_FULL_ARTICLE: "false" })).toBe(false);
  });

  it("reads nothing at all with the switch off", async () => {
    const untouchable = new Proxy({}, { get: () => { throw new Error("read with the switch off"); } });
    expect(await readFirstArticleBody(untouchable as never, "u1", "ws1", { env: { PRETRIAL_FULL_ARTICLE: "0" }, service: untouchable as never })).toEqual({ ok: false, reason: "off" });
  });

  it("keeps the article and drops what runs, embeds, navigates or is the writer's scaffolding", () => {
    const html = [
      "```html",
      "<h1>Title</h1>",
      '<p onclick="steal()">Kept <a href="javascript:alert(1)">link</a> and <a href="https://ok.example">ok</a>.</p>',
      "<script>alert(1)</script><style>p{}</style><iframe src=\"https://x.example\"></iframe>",
      "<h2>Section</h2><p>See {{internal-link:pricing guide}}.</p>",
      "<meta-description>The meta.</meta-description>",
      "<p>Half a sentence still being writ",
    ].join("\n");
    const out = readableHtml(html);
    expect(out).toContain("<p>Kept <a>link</a> and <a href=\"https://ok.example\" rel=\"nofollow noopener noreferrer\" target=\"_blank\" tabindex=\"-1\">ok</a>.</p>");
    expect(out).toContain("<h2>Section</h2><p>See pricing guide.</p>");
    expect(out).toContain("Half a sentence still being writ");
    for (const gone of ["<h1", "onclick", "javascript:", "<script", "<style", "<iframe", "meta-description", "```"]) expect(out).not.toContain(gone);
  });
});

describe("the reader's html, beyond the allowlist", () => {
  it("takes the finished article's table of contents out, label and all", () => {
    const saved =
      "<p>Intro.</p><p><strong>Contents</strong></p><ul><li><a href=\"#one\">One</a></li><li><p><a href=\"#two\">Two</a></p></li></ul>" +
      "<h2 id=\"one\">One</h2><p>See <a href=\"https://ok.example\">this</a>.</p><ul><li>A real list</li></ul>";
    const out = readableHtml(saved);
    expect(out).not.toContain("Contents");
    expect(out).not.toContain("#one");
    expect(out).toContain("<h2>One</h2>");
    expect(out).toContain("<ul><li>A real list</li></ul>");
  });

  it("holds back a link placeholder the writer is half-way through", () => {
    expect(readableHtml("<p>See {{internal-li")).toBe("<p>See </p>");
    expect(readableHtml("<p>See {{internal-link: pricing}} now")).toBe("<p>See pricing now</p>");
  });
});

describe("deployed before migration 108", () => {
  // A chainable fake: every filter returns itself; maybeSingle answers by
  // table and the columns asked for.
  function fake(answer: (table: string, columns: string) => { data: unknown; error: unknown }) {
    const asked: string[] = [];
    const client = {
      asked,
      from(table: string) {
        let columns = "";
        const q = {
          select(c: string) { columns = c; return q; },
          eq() { return q; }, neq() { return q; }, in() { return q; }, gt() { return q; }, order() { return q; }, limit() { return q; },
          async maybeSingle() { asked.push(`${table}:${columns}`); return answer(table, columns); },
        };
        return q;
      },
    };
    return client;
  }
  const person = fake((table) => {
    if (table === "workspaces") return { data: { id: "ws1", account_id: "acc1" }, error: null };
    if (table === "account_members") return { data: { role: "owner" }, error: null };
    if (table === "onboarding_runs") return { data: { article_id: "a1" }, error: null };
    return { data: null, error: null };
  });
  const noColumn = () => fake((_table, columns) => {
    if (columns === "id") return { data: { id: "a1" }, error: null };
    if (columns.includes("body_progress")) return { data: null, error: { code: "42703", message: "column articles.body_progress does not exist" } };
    return { data: { id: "a1", status: "drafting", word_count: 0, content: null, body_stream: "<p>So far</p>", instructions_snapshot: null }, error: null };
  });

  it("reads the text and whether it is done without the column, instead of a refusal", async () => {
    const service = noColumn();
    const read = await readFirstArticleBody(person as never, "u1", "ws1", { env: { PRETRIAL_FULL_ARTICLE: "1" }, service: service as never });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.html).toBe("<p>So far</p>");
      expect(read.done).toBe(false);
      expect(read.progress.sectionsDone).toEqual([]);
    }
    expect(service.asked.some((a) => a.includes("body_stream") && !a.includes("body_progress"))).toBe(true);
  });

  it("answers the progress route with no ticks rather than a 404", async () => {
    const read = await readFirstArticleProgress(person as never, "u1", "ws1", { service: noColumn() as never });
    expect(read).toMatchObject({ ok: true, done: false, stage: null, sectionsDone: [], words: 0 });
  });
});

describe("a setup run that ended partial, its first article written later by cron", () => {
  // Rows filtered for real: eq / in / gt / order by created_at, so which
  // article answers is decided by the same rules as the database's.
  type Row = Record<string, unknown>;
  function table(rows: Record<string, Row[]>) {
    return {
      from(name: string) {
        let out = [...(rows[name] ?? [])];
        let columns = "";
        const q = {
          select(c: string) { columns = c; return q; },
          eq(k: string, v: unknown) { out = out.filter((r) => r[k] === v); return q; },
          neq(k: string, v: unknown) { out = out.filter((r) => r[k] !== v); return q; },
          in(k: string, vs: unknown[]) { out = out.filter((r) => vs.includes(r[k])); return q; },
          gt(k: string, v: number) { out = out.filter((r) => Number(r[k]) > v); return q; },
          order(k: string, o: { ascending: boolean }) {
            out.sort((a, b) => String(a[k]).localeCompare(String(b[k])) * (o.ascending ? 1 : -1));
            return q;
          },
          limit(n: number) { out = out.slice(0, n); return q; },
          async maybeSingle() {
            const row = out[0];
            if (!row) return { data: null, error: null };
            return { data: columns === "*" ? row : Object.fromEntries(columns.split(/,\s*/).map((c) => [c, row[c] ?? null])), error: null };
          },
        };
        return q;
      },
    };
  }
  const owner = table({
    workspaces: [{ id: "ws1", account_id: "acc1" }],
    account_members: [{ account_id: "acc1", user_id: "u1", role: "owner" }],
    // Partial: the run never got an article id.
    onboarding_runs: [{ workspace_id: "ws1", article_id: null, started_at: "2026-10-20T10:00:00Z" }],
  });
  const cronWrote = {
    id: "cron1", workspace_id: "ws1", status: "review", word_count: 1200, created_at: "2026-10-21T03:00:00Z",
    content: "<p>Written by the cron.</p>", body_stream: null, body_progress: null, instructions_snapshot: null,
  };
  const ON = { PRETRIAL_FULL_ARTICLE: "1" };

  it("reads the article the card shows instead of refusing", async () => {
    const service = table({
      articles: [
        // Errored and empty rows the card skips, older than the one it shows.
        { id: "err", workspace_id: "ws1", status: "error", word_count: 0, created_at: "2026-10-20T10:05:00Z" },
        cronWrote,
        { id: "next", workspace_id: "ws1", status: "review", word_count: 900, created_at: "2026-10-22T03:00:00Z", content: "<p>Not this one.</p>" },
        // Another site's older article never answers.
        { id: "other", workspace_id: "ws2", status: "live", word_count: 800, created_at: "2026-10-01T00:00:00Z", content: "<p>Theirs.</p>" },
      ],
    });
    const read = await readFirstArticleBody(owner as never, "u1", "ws1", { env: ON, service: service as never });
    expect(read).toMatchObject({ ok: true, articleId: "cron1", done: true });
    if (read.ok) expect(read.html).toBe("<p>Written by the cron.</p>");
    expect(await readFirstArticleProgress(owner as never, "u1", "ws1", { service: service as never })).toMatchObject({ ok: true, articleId: "cron1", done: true, words: 1200 });
  });

  it("prefers a written article over an older one still being written, as the card does", async () => {
    const service = table({
      articles: [
        { id: "drafting", workspace_id: "ws1", status: "drafting", word_count: 0, created_at: "2026-10-20T10:05:00Z", body_stream: "<p>Half</p>" },
        cronWrote,
      ],
    });
    expect(await readFirstArticleBody(owner as never, "u1", "ws1", { env: ON, service: service as never })).toMatchObject({ ok: true, articleId: "cron1" });
  });

  it("streams the article being written while nothing is written yet", async () => {
    const service = table({
      articles: [{ id: "drafting", workspace_id: "ws1", status: "drafting", word_count: 0, created_at: "2026-10-20T10:05:00Z", content: null, body_stream: "<p>Half</p>", body_progress: null, instructions_snapshot: null }],
    });
    expect(await readFirstArticleBody(owner as never, "u1", "ws1", { env: ON, service: service as never })).toMatchObject({ ok: true, articleId: "drafting", done: false, html: "<p>Half</p>" });
  });

  it("still refuses a member who is not the owner, and a site with no article", async () => {
    const editor = table({
      workspaces: [{ id: "ws1", account_id: "acc1" }],
      account_members: [{ account_id: "acc1", user_id: "u2", role: "editor" }],
    });
    const service = table({ articles: [cronWrote] });
    expect(await readFirstArticleBody(editor as never, "u2", "ws1", { env: ON, service: service as never })).toEqual({ ok: false, reason: "not-owner" });
    expect(await readFirstArticleBody(owner as never, "u1", "ws1", { env: ON, service: table({ articles: [] }) as never })).toEqual({ ok: false, reason: "no-first-article" });
  });
});
