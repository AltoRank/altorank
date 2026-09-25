/**
 * The first article's card, and when the setup screen may offer to run again.
 *
 * The card is what an account before its trial sees of the article setup
 * wrote: title, keyword, day, H2 outline, length, sources. The rule that
 * matters is the negative one - nothing in it is the text - so it is asserted
 * on the serialised card, the same bytes that reach the page.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// The text the outline is pulled from is read on the server, never through
// the caller's client (migration 097; lib/articles/body-read.ts). This is
// that server read, answering from the same rows the fake client holds.
let bodies: Record<string, unknown> = {};
const serverReads: string[][] = [];
vi.mock("@/lib/articles/body-read", () => ({
  readArticlesWhole: async (ids: string[], columns: string) => {
    serverReads.push([...ids, columns]);
    return ids.filter((id) => id in bodies).map((id) => ({ id, content: bodies[id] }));
  },
}));
beforeEach(() => {
  serverReads.length = 0;
});

import {
  articleOutline,
  contentHtml,
  loadFirstArticle,
  sourcesCited,
  toFirstArticleCard,
} from "../first-article";
import { offerSetupRetry, runStateOf, setupFellShort } from "../setup-retry";
import { onboardingOutcome, type OnboardingRunRow, type OnboardingRunSnapshot } from "../events";

const INTRO = "Bu giriş paragrafı deneme süresi başlamadan kopyalanamamalı.";
const PARAGRAPH = "Ajanslar bu yöntemi üç haftada uygular ve sonuçları ölçer.";

const text = (t: string) => ({ type: "text", text: t });
const h = (level: number, t: string) => ({ type: "heading", attrs: { level }, content: [text(t)] });
const p = (...c: unknown[]) => ({ type: "paragraph", content: c });
const link = (t: string, href: string) => ({ type: "text", text: t, marks: [{ type: "link", attrs: { href } }] });

const doc = {
  type: "doc",
  content: [
    p(text(INTRO)),
    h(2, "Neden önemli"),
    p(text(PARAGRAPH), link("rapor", "https://research.example/report?utm_source=x")),
    h(3, "Alt başlık"),
    p(link("aynı rapor", "https://www.research.example/report/")),
    h(2, "Nasıl başlanır"),
    p(link("ikinci kaynak", "https://stats.example/data"), link("kendi sayfamız", "https://acme-agency.example/hizmetler")),
    h(2, ""),
  ],
};

describe("articleOutline", () => {
  it("is the H2 headings in order, text only, blanks dropped", () => {
    expect(articleOutline(contentHtml(doc))).toEqual(["Neden önemli", "Nasıl başlanır"]);
  });

  it("reads HTML stored by older rows too", () => {
    expect(articleOutline("<h2>Bir &amp; iki</h2><p>x</p><h2><strong>Üç</strong></h2>")).toEqual(["Bir & iki", "Üç"]);
  });

  it("is empty for an article with no sections, not invented", () => {
    expect(articleOutline(contentHtml({ type: "doc", content: [p(text(INTRO))] }))).toEqual([]);
  });
});

describe("sourcesCited", () => {
  it("counts distinct outside pages, not links, and not the site's own", () => {
    // research.example twice under two spellings, stats.example once; the
    // link to the site itself is not a source.
    expect(sourcesCited(contentHtml(doc), "acme-agency.example")).toBe(2);
  });

  it("is zero when nothing is cited - a measurement, not a gap", () => {
    expect(sourcesCited(contentHtml({ type: "doc", content: [p(text(INTRO))] }), "acme-agency.example")).toBe(0);
  });
});

describe("toFirstArticleCard", () => {
  const row = { id: "a1", title: "Ajanslar için rehber", keyword: "ajans rehberi", word_count: 1840, fact_check_verdict: "clean", content: doc };

  it("carries the shape and none of the text", () => {
    const card = toFirstArticleCard(row, { domain: "acme-agency.example", scheduledDate: "2026-10-01", more: 0 });
    expect(card).toEqual({
      id: "a1",
      title: "Ajanslar için rehber",
      keyword: "ajans rehberi",
      scheduledDate: "2026-10-01",
      outline: ["Neden önemli", "Nasıl başlanır"],
      wordCount: 1840,
      sources: 2,
      verdict: "clean",
      more: 0,
    });
    const bytes = JSON.stringify(card);
    expect(bytes).not.toContain(INTRO);
    expect(bytes).not.toContain(PARAGRAPH);
    expect(bytes).not.toContain("research.example");
  });

  it("says nothing about a verdict it does not recognise", () => {
    expect(toFirstArticleCard({ ...row, fact_check_verdict: null }, { domain: null, scheduledDate: null, more: 0 }).verdict).toBeNull();
  });
});

/**
 * A client for the three reads loadFirstArticle makes, holding a client
 * token's privileges since migration 097: a select or a filter that names the
 * text is refused, as PostgREST refuses it.
 */
function fakeClient(opts: {
  written?: Record<string, unknown>[];
  drafting?: number;
  entry?: { scheduled_date: string } | null;
  error?: string;
  draftingError?: string;
}) {
  bodies = Object.fromEntries((opts.written ?? []).map((r) => [r.id as string, r.content]));
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let denied = false;
      const q: Record<string, unknown> = {};
      const chain = () => q;
      const deny = (col: string) => {
        if (table === "articles" && /\b(content|meta_description)\b/.test(col)) denied = true;
      };
      Object.assign(q, {
        select: (c: string, o?: { head?: boolean }) => (deny(c), (filters.head = o?.head ?? false), q),
        eq: (col: string, v: unknown) => ((filters[col] = v), q),
        in: chain,
        not: (col: string) => (deny(col), q),
        gt: chain,
        order: chain,
        limit: chain,
        maybeSingle: async () => ({ data: table === "calendar_entries" ? opts.entry ?? null : null, error: null }),
        then: (ok: (v: unknown) => unknown) => {
          if (denied) return Promise.resolve({ data: null, count: null, error: { message: "permission denied for table articles" } }).then(ok);
          if (table === "articles" && filters.status === "drafting") {
            if (opts.draftingError) return Promise.resolve({ count: null, error: { message: opts.draftingError } }).then(ok);
            return Promise.resolve({ count: opts.drafting ?? 0, error: null }).then(ok);
          }
          if (opts.error) return Promise.resolve({ data: null, count: null, error: { message: opts.error } }).then(ok);
          // What the client may see: the rows without their text.
          const rows = (opts.written ?? []).map(({ content: _content, ...rest }) => (void _content, rest));
          return Promise.resolve({ data: rows.slice(0, 1), count: rows.length, error: null }).then(ok);
        },
      });
      return q;
    },
  } as never;
}

describe("loadFirstArticle", () => {
  const written = [
    { id: "a1", title: "İlk", keyword: "ajans rehberi", word_count: 1200, fact_check_verdict: "review", content: doc },
    { id: "a2", title: "İkinci", keyword: "b", word_count: 900, fact_check_verdict: "clean", content: doc },
  ];

  it("is the workspace's oldest written article, with its day and how many more there are", async () => {
    const fact = await loadFirstArticle(fakeClient({ written, entry: { scheduled_date: "2026-10-02" } }), "ws", "acme-agency.example");
    expect(fact.writing).toBe(false);
    expect(fact.article).toMatchObject({ id: "a1", scheduledDate: "2026-10-02", more: 1, outline: ["Neden önemli", "Nasıl başlanır"] });
  });

  it("says so when the article is not on the calendar, rather than guessing a day", async () => {
    const fact = await loadFirstArticle(fakeClient({ written, entry: null }), "ws", "acme-agency.example");
    expect(fact.article?.scheduledDate).toBeNull();
  });

  it("reports an article being written, so no retry is offered over it", async () => {
    expect(await loadFirstArticle(fakeClient({ written: [], drafting: 1 }), "ws", null)).toEqual({ article: null, writing: true });
  });

  it("a failed read is an error, never 'no article'", async () => {
    await expect(loadFirstArticle(fakeClient({ error: "timeout" }), "ws", null)).rejects.toThrow(/could not read/);
  });

  // Read as "nothing is being written", a failure here would offer the paid
  // re-run while the article was being written.
  it("a failed read of what is being written is an error too, never 'nothing'", async () => {
    await expect(loadFirstArticle(fakeClient({ written: [], draftingError: "timeout" }), "ws", null)).rejects.toThrow(
      /could not tell whether an article is being written/,
    );
  });

  it("reads the text on the server, for the one article, and never through the caller's client", async () => {
    const fact = await loadFirstArticle(fakeClient({ written, entry: null }), "ws", "acme-agency.example");
    expect(fact.article?.outline).toEqual(["Neden önemli", "Nasıl başlanır"]);
    expect(serverReads).toEqual([["a1", "content"]]);
    const bytes = JSON.stringify(fact);
    expect(bytes).not.toContain(INTRO);
    expect(bytes).not.toContain(PARAGRAPH);
  });
});

function snapshot(run: Partial<OnboardingRunRow> | null, stale = false): OnboardingRunSnapshot {
  if (!run) return { run: null, article: null, stale: false };
  return {
    run: {
      id: "r1",
      workspace_id: "ws",
      status: "done",
      phases: [],
      planned: [],
      keywords_found: 10,
      article_id: null,
      error: null,
      started_at: "2026-09-25T10:00:00Z",
      updated_at: "2026-09-25T10:05:00Z",
      finished_at: "2026-09-25T10:05:00Z",
      ...run,
    },
    article: null,
    stale,
  };
}

describe("offerSetupRetry", () => {
  const none = { hasArticle: false, writing: false };

  // The defect this exists for: a later visit read "no draft" off the run
  // and its retry paid for a whole second setup beside an existing article.
  it("never offers a run again when the site has a first article, whatever the run says", () => {
    const failed = runStateOf(snapshot({ status: "error", error: "boom" }));
    expect(offerSetupRetry(failed, { hasArticle: true, writing: false })).toBe(false);
  });

  it("never offers it while an article is being written", () => {
    expect(offerSetupRetry(runStateOf(snapshot({ status: "error", error: "boom" })), { hasArticle: false, writing: true })).toBe(false);
  });

  it("offers it when the run failed and nothing exists", () => {
    expect(offerSetupRetry(runStateOf(snapshot({ status: "error", error: "boom" })), none)).toBe(true);
  });

  it("offers it when the run stopped responding", () => {
    expect(offerSetupRetry(runStateOf(snapshot({ status: "running", finished_at: null }, true)), none)).toBe(true);
  });

  it("offers it when the draft step failed even though a plan was made", () => {
    const run = runStateOf(
      snapshot({
        status: "partial",
        planned: [{ term: "ajans rehberi", date: "2026-10-01" }],
        phases: [{ phase: "drafting", status: "failed", detail: "The draft could not be started (500)." }],
      }),
    );
    expect(offerSetupRetry(run, none)).toBe(true);
  });

  it("does not offer it when the run decided not to write: running it again buys the same answer", () => {
    const run = runStateOf(
      snapshot({
        status: "partial",
        planned: [{ term: "ajans rehberi", date: "2026-10-01" }],
        phases: [{ phase: "drafting", status: "skipped", detail: "No keyword clear enough to write yet." }],
      }),
    );
    expect(offerSetupRetry(run, none)).toBe(false);
  });

  it("does not offer it while the run is still going", () => {
    expect(offerSetupRetry(runStateOf(snapshot({ status: "running", finished_at: null })), none)).toBe(false);
  });

  it("offers the first run when setup was skipped and never ran", () => {
    expect(offerSetupRetry(runStateOf(snapshot(null)), none)).toBe(true);
  });

  it("setupFellShort is false for a run that produced its article", () => {
    const run = runStateOf(snapshot({ status: "done", planned: [{ term: "x", date: "2026-10-01" }], article_id: "a1" }));
    expect(run && setupFellShort(run)).toBe(false);
  });
});

describe("the run's closing line before the trial", () => {
  const done = () => runStateOf(snapshot({ status: "done", planned: [{ term: "x", date: "2026-10-01" }], article_id: "a1" }));
  it("does not send an account before its trial to a review queue it cannot open", () => {
    const state = done()!;
    state.article = { id: "a1", title: "t", keyword: "x", wordCount: 10, verdict: "clean" };
    expect(onboardingOutcome(state, false, { preTrial: true }).line).toBe("Done. 1 article on the calendar and your first article is written.");
    expect(onboardingOutcome(state).line).toBe("Done. 1 article on the calendar and your first draft is in review.");
  });
});
