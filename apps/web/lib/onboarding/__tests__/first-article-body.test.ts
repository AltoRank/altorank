import { describe, expect, it } from "vitest";
import { fullArticleOn, readableHtml, readFirstArticleBody, readFirstArticleProgress } from "../first-article-body";

describe("the gate's full-article reader", () => {
  it("is off unless PRETRIAL_FULL_ARTICLE is exactly 1", () => {
    expect(fullArticleOn({})).toBe(false);
    expect(fullArticleOn({ PRETRIAL_FULL_ARTICLE: "true" })).toBe(false);
    expect(fullArticleOn({ PRETRIAL_FULL_ARTICLE: "1" })).toBe(true);
  });

  it("reads nothing at all with the switch off", async () => {
    const untouchable = new Proxy({}, { get: () => { throw new Error("read with the switch off"); } });
    expect(await readFirstArticleBody(untouchable as never, "u1", "ws1", { env: {}, service: untouchable as never })).toEqual({ ok: false, reason: "off" });
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
    expect(out).toContain("<p>Kept <a>link</a> and <a href=\"https://ok.example\" rel=\"nofollow noopener noreferrer\">ok</a>.</p>");
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
          eq() { return q; }, neq() { return q; }, order() { return q; }, limit() { return q; },
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
