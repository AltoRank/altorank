import { beforeEach, describe, expect, it, vi } from "vitest";
const { quota, generate, schedule, wake, sweep, prepare } = vi.hoisted(() => ({ quota: vi.fn(), generate: vi.fn(), schedule: vi.fn(), wake: vi.fn(), sweep: vi.fn(), prepare: vi.fn() }));
vi.mock("@/lib/billing/quota", () => ({ getQuota: quota }));
vi.mock("@/lib/content/generate", () => ({ generateArticle: generate }));
vi.mock("@/lib/content/stale-drafts", () => ({ sweepStaleDrafts: sweep }));
vi.mock("@/lib/content/fan-out", () => ({ selfInvocation: () => ({}), selfInvoke: wake }));
vi.mock("@/lib/content/draft-preparation", async original => ({ ...await original<typeof import("@/lib/content/draft-preparation")>(), prepareDraft: prepare }));
vi.mock("../plan", () => ({ schedulePlan: schedule, fulfilPlannedEntry: async (db: ReturnType<typeof database>, id: string, article: string) => { await db.from("calendar_entries").update({ article_id: article }).eq("id", id); } }));
import { prepareFirstMonthStep, queueFirstMonth } from "../first-month";
import { DRAFT_PREPARATION_VERSION, draftPreparationContext, type DraftPreparationInput, type DraftPreparation } from "@/lib/content/draft-preparation";
import { contextKey, OPPORTUNITY_VERSION, type Opportunity } from "@/lib/keyword-research/opportunity";
import { currentResearchBudget } from "@/lib/seo/request-context";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Relational fixture permits heterogeneous table columns.
type Row = Record<string, any>; // A small relational fixture, not provider output.
let tables: Record<string, Row[]>;
function database() {
  return { from(table: string) {
    let filter: (row: Row) => boolean = () => true;
    let values: Row | undefined;
    let inserted: Row[] | undefined;
    let conflict = ["workspace_id", "entry_id"];
    let ignoreDuplicates = false;
    let single = false;
    let cap = Infinity;
    const where = (predicate: (row: Row) => boolean) => { const before = filter; filter = row => before(row) && predicate(row); return q; };
    const q = {
      select: () => q, order: () => q,
      eq: (key: string, value: unknown) => where(row => row[key] === value),
      in: (key: string, value: unknown[]) => where(row => value.includes(row[key])),
      is: (key: string, value: unknown) => where(row => (row[key] ?? null) === value),
      not: (key: string) => where(row => row[key] != null),
      gte: (key: string, value: string) => where(row => row[key] >= value),
      lt: (key: string, value: string) => where(row => row[key] < value),
      limit: (limit: number) => (cap = limit, q),
      maybeSingle: () => (single = true, q), single: () => (single = true, q),
      update: (patch: Row) => (values = patch, q),
      upsert: (rows: Row | Row[], options?: {onConflict?: string; ignoreDuplicates?: boolean}) => { inserted = Array.isArray(rows) ? rows : [rows]; conflict = options?.onConflict?.split(",") ?? conflict; ignoreDuplicates = options?.ignoreDuplicates ?? false; return q; },
      then: (resolve: (result: unknown) => unknown) => {
        const rows = tables[table] ??= [];
        if (inserted) for (const row of inserted) {
          const existing = rows.find(existing => conflict.every(key => existing[key] === row[key]));
          if (!existing) rows.push({ status: "queued", ...row });
          else if (!ignoreDuplicates) Object.assign(existing, row);
        }
        const matches = rows.filter(filter).slice(0, cap);
        if (values) matches.forEach(row => Object.assign(row, values));
        return resolve({ data: single ? matches[0] ?? null : matches, count: matches.length, error: null });
      },
    };
    return q;
  } };
}
const step = () => prepareFirstMonthStep(database() as never, "site-a", "lease-a");
const profile = { primaryBuyer: "Small teams", priorityOffering: "Writing software" };
const businessContext = { domain: "publisher.test", business: profile, languageCode: "en", locationCode: 2840 };
function input(index = 0): DraftPreparationInput {
  const site = tables.workspaces[0], keyword = tables.keywords[index];
  return { workspaceId: "site-a", keywordId: keyword.id, keyword: keyword.term, brief: keyword.opportunity, profile: site.business_profile, domain: site.domain, language: site.language, locationCode: site.location_code, instructions: keyword.instructions };
}
function packet(value: DraftPreparationInput, status: DraftPreparation["status"] = "ready"): DraftPreparation {
  const question = "What limits matter to this reader?", quote = "Compare the supported writing limits before selecting a tool.";
  return { version: DRAFT_PREPARATION_VERSION, context: draftPreparationContext(value), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now()+3600000).toISOString(), status,
    sources: [{url:"https://publisher.test/guide", title:"Guide", headings:[], text:quote}],
    plan: {task:"explanation", status:"planned", requirements:[question], selectedUrls:[], retrievedUrls:[],scope:{status:"checked",requirements:[question],omitted:[],promises:[{id:"p0",source:"headline",quote:value.brief.angle!,text:value.brief.angle!,expectedAnswer:"Explain the approved reader task using the quoted evidence.",mappingReason:"The fixture question asks for the approved task.",requirementIndices:[0]}]}},
    sourceBrief: {status:status==="ready"?"prepared":status, facts:[{subject:"Writing software",plan:"",kind:"explanation",statement:quote,quote,scopeQuote:quote,sourceIndex:0,url:"https://publisher.test/guide"}], coverage:[{question,factIndices:[0]}], issues:[], readiness:{status:"checked",questions:[{requirementIndex:0,answered:true,reason:"The source answers this question."}],promises:[{promiseId:"p0",answered:true,reason:"The quoted evidence supports the fixture promise."}]}},
  };
}
async function savePacket(db: ReturnType<typeof database>, value: DraftPreparationInput, status: DraftPreparation["status"] = "ready") {
  const prepared = packet(value, status);
  await db.from("draft_preparations").upsert({workspace_id:value.workspaceId,keyword_id:value.keywordId,payload:prepared}, {onConflict:"workspace_id,keyword_id"});
  return prepared;
}
beforeEach(() => {
  vi.clearAllMocks();
  quota.mockResolvedValue({ reason: "plan", remaining: 99, limit: 100, used: 1 });
  wake.mockResolvedValue({ ok: true });
  tables = {
    workspaces: [{ id: "site-a", account_id: "account", auto_generate: true, auto_generate_weekly_limit: 7, domain:businessContext.domain, language:"en", location_code:2840, business_profile:profile }, { id: "site-b", account_id: "other-account", auto_generate: true, auto_generate_weekly_limit: 7 }],
    onboarding_runs: [{ workspace_id: "site-a", article_id: "preview" }],
    first_month_runs: [{ workspace_id: "site-a", starts_on: "2026-09-13", status: "writing", planned: true, lease: "lease-a", planning_attempts: 0 }],
    first_month_jobs: [], calendar_entries: [], keywords: [], draft_preparations: [],
    articles: [{ id: "preview", workspace_id: "site-a", keyword_id: "first", status: "review" }],
  };
  generate.mockImplementation(async ({ keywordId }) => {
    const articleId = `article-${keywordId}`;
    tables.articles.push({ id: articleId, workspace_id: "site-a", keyword_id: keywordId, status: "review" });
    return { articleId };
  });
  prepare.mockImplementation(async (db, value) => savePacket(db, value));
});
function jobs(count: number, prepared = true) {
  for (let i = 0; i < count; i++) {
    tables.first_month_jobs.push({ id: `job${i}`, entry_id: `entry${i}`, workspace_id: "site-a", status: "queued", attempts: 0 });
    tables.calendar_entries.push({ id: `entry${i}`, workspace_id: "site-a", keyword_id: `keyword${i}`, keyword: `topic${i}`, status: "queue", scheduled_date: "2026-09-15", article_id: null });
    const evidenceUrls = ["https://publisher.test/guide", "https://another.test/writing-guide"];
    const brief: Opportunity = {version:OPPORTUNITY_VERSION,context:contextKey(businessContext),checkedAt:new Date().toISOString(),status:"qualified",reason:"Helps the buyer compare tools",audience:"Small teams",buyingJob:"Compare writing tools",offering:"Writing software",angle:`How to compare topic ${i}`,format:"article",evidenceUrls,organicUrls:evidenceUrls,conversionPath:"https://publisher.test"};
    tables.keywords.push({ id: `keyword${i}`, workspace_id: "site-a", term:`topic${i}`, instructions:null, opportunity:brief });
    if (prepared) tables.draft_preparations.push({workspace_id:"site-a",keyword_id:`keyword${i}`,payload:packet(input(i))});
  }
}
describe("first-month preparation", () => {
  it("activation is idempotent, raises the default pace and leaves another account alone", async () => {
    tables.first_month_runs = [];
    const db = database() as never;
    await queueFirstMonth(db, "account", "starter");
    await queueFirstMonth(db, "account", "starter");
    expect(tables.first_month_runs).toHaveLength(1);
    expect(tables.workspaces.map(row => row.auto_generate_weekly_limit)).toEqual([14, 7]);
    expect(tables.articles.map(row => row.id)).toEqual(["preview"]);
  });
  it("preserves a custom publishing pace", async () => {
    tables.first_month_runs = [];
    tables.workspaces[0].auto_generate_weekly_limit = 2;
    await queueFirstMonth(database() as never, "account", "starter");
    expect(tables.workspaces[0].auto_generate_weekly_limit).toBe(2);
  });
  it("a repeated activation does not overwrite a pace the customer changed afterwards", async () => {
    tables.first_month_runs = [];
    await queueFirstMonth(database() as never, "account", "starter");
    tables.workspaces[0].auto_generate_weekly_limit = 7;
    await queueFirstMonth(database() as never, "account", "starter");
    expect(tables.workspaces[0].auto_generate_weekly_limit).toBe(7);
  });
  it.each(["no-plan", "empty-quota", "paused"])("does not write for %s", async reason => {
    jobs(1);
    if (reason === "no-plan") quota.mockResolvedValue({ reason: "no-plan", remaining: 6 });
    if (reason === "empty-quota") quota.mockResolvedValue({ reason: "plan", remaining: 0 });
    if (reason === "paused") tables.workspaces[0].auto_generate = false;
    await step();
    expect(generate).not.toHaveBeenCalled();
    expect(tables.first_month_runs[0].status).toBe("blocked");
  });
  it("prepares more than the old six-draft batch, one invocation at a time, preserving the preview", async () => {
    jobs(9);
    for (let i = 0; i < 10; i++) { tables.first_month_runs[0].lease = "lease-a"; await step(); }
    expect(generate).toHaveBeenCalledTimes(9);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ autonomous: true, verifySourceClaims: true, billToAccountId: "account", expectedPreparationContext:expect.any(String), expectedPreparationCreatedAt:expect.any(String) }));
    expect(prepare).not.toHaveBeenCalled();
    expect(tables.first_month_runs[0].status).toBe("ready");
    expect(tables.first_month_jobs.every(job => job.status === "ready")).toBe(true);
    expect(tables.articles[0].id).toBe("preview");
    expect(tables.articles.every(article => article.status === "review")).toBe(true);
  });
  it("recovers a saved article after a lost response instead of writing it again", async () => {
    jobs(1);
    tables.first_month_jobs[0].attempts = 2;
    tables.articles.push({ id: "already-saved", workspace_id: "site-a", keyword_id: "keyword0", status: "review" });
    await step();
    expect(generate).not.toHaveBeenCalled();
    expect(tables.calendar_entries[0].article_id).toBe("already-saved");
  });
  it.each(["last-allowance", "paused", "no-plan"])("attaches an interrupted saved draft despite %s", async reason => {
    jobs(1);
    tables.first_month_jobs[0].attempts = 2;
    tables.first_month_jobs[0].status = "writing";
    tables.articles.push({id:"last-saved-draft",workspace_id:"site-a",keyword_id:"keyword0",status:"review"});
    if (reason === "last-allowance") quota.mockResolvedValue({reason:"plan",remaining:0});
    if (reason === "paused") tables.workspaces[0].auto_generate = false;
    if (reason === "no-plan") quota.mockResolvedValue({reason:"no-plan",remaining:0});
    await step();
    expect(tables.calendar_entries[0].article_id).toBe("last-saved-draft");
    expect(tables.first_month_jobs[0]).toMatchObject({status:"ready",article_id:"last-saved-draft",attempts:2});
    expect(quota).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    tables.first_month_runs[0].lease = "lease-a";
    await step();
    expect(tables.first_month_runs[0].status).toBe("ready");
  });
  it("finishes a fully saved month when the final article used the last allowance", async () => {
    jobs(1);
    tables.first_month_jobs[0].status = "ready";
    quota.mockResolvedValue({ reason: "plan", remaining: 0 });
    await step();
    expect(tables.first_month_runs[0].status).toBe("ready");
    expect(tables.first_month_runs[0].lease).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });
  it("does not spend on unsupported topics and exposes failure after bounded attempts", async () => {
    jobs(1); tables.keywords[0].opportunity.status = "pending";
    await step(); tables.first_month_runs[0].lease = "lease-a"; await step();
    tables.first_month_runs[0].lease = "lease-a"; await step();
    expect(generate).not.toHaveBeenCalled();
    expect(tables.first_month_jobs[0].status).toBe("failed");
    expect(tables.first_month_runs[0].status).toBe("attention");
  });
  it("budgets existing queued topics before adding more and keeps the fixed month", async () => {
    jobs(2); tables.first_month_runs[0].planned = false;
    quota.mockResolvedValue({ reason: "plan", remaining: 3 });
    await step();
    expect(schedule).toHaveBeenCalledWith(expect.anything(), "site-a", 7, expect.objectContaining({ mode: "fill-month", from: new Date("2026-09-13T00:00:00Z"), maxEntries: 1 }));
    expect(generate).not.toHaveBeenCalled();
  });
  it("prepares sources in one invocation and writes from the saved context in the next", async () => {
    jobs(1, false);
    const before = structuredClone(tables.articles);
    prepare.mockImplementation(async (db, value) => {
      const budget = currentResearchBudget();
      expect(budget?.maxCalls).toBe(30);
      expect(budget!.deadline-Date.now()).toBeLessThanOrEqual(180000);
      return savePacket(db, value);
    });
    await step();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();
    expect(sweep).not.toHaveBeenCalled();
    expect(tables.articles).toEqual(before);
    expect(tables.first_month_jobs[0]).toMatchObject({status:"queued",attempts:0});
    expect(tables.first_month_runs[0].lease).toBeNull();
    expect(wake).toHaveBeenCalledTimes(1);
    const expectedContext = tables.draft_preparations[0].payload.context;
    const expectedCreatedAt = tables.draft_preparations[0].payload.createdAt;
    tables.first_month_runs[0].lease = "lease-a";
    await step();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({expectedPreparationContext:expectedContext,expectedPreparationCreatedAt:expectedCreatedAt}));
    expect(tables.first_month_jobs[0]).toMatchObject({status:"ready",attempts:1,article_id:"article-keyword0"});
    expect(tables.articles[0]).toEqual(before[0]);
  });
  it.each(["instructions", "global-instructions", "expired", "task"])("refreshes a %s-mismatched packet before writing", async change => {
    jobs(1);
    const oldContext = tables.draft_preparations[0].payload.context;
    if (change === "instructions") tables.keywords[0].instructions = "Focus on monthly limits.";
    if (change === "global-instructions") tables.workspace_output_settings = [{workspace_id:"site-a",global_article_prompt:"Always mention the free tier."}];
    if (change === "expired") tables.draft_preparations[0].payload.expiresAt = new Date(Date.now()-1000).toISOString();
    if (change === "task") tables.keywords[0].opportunity.angle = "How to compare export limits";
    await step();
    expect(generate).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledTimes(1);
    if (change === "global-instructions") expect(prepare).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({globalInstructions:"Always mention the free tier."}),expect.anything());
    const renewedContext = tables.draft_preparations[0].payload.context;
    const renewedCreatedAt = tables.draft_preparations[0].payload.createdAt;
    if (change !== "expired") expect(renewedContext).not.toBe(oldContext);
    tables.first_month_runs[0].lease = "lease-a";
    await step();
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({expectedPreparationContext:renewedContext,expectedPreparationCreatedAt:renewedCreatedAt}));
  });
  it("rechecks quota after source preparation before starting the writer", async () => {
    jobs(1, false);
    await step();
    quota.mockResolvedValue({reason:"plan",remaining:0});
    tables.first_month_runs[0].lease = "lease-a";
    await step();
    expect(generate).not.toHaveBeenCalled();
    expect(tables.first_month_runs[0].status).toBe("blocked");
    expect(tables.first_month_jobs[0].attempts).toBe(0);
  });
  it("fails insufficient sources once and continues to another supported job", async () => {
    jobs(2, false);
    prepare.mockImplementation(async (db, value) => savePacket(db, value, value.keywordId === "keyword0" ? "insufficient" : "ready"));
    await step();
    expect(tables.first_month_jobs[0]).toMatchObject({status:"failed",attempts:1});
    expect(generate).not.toHaveBeenCalled();
    tables.first_month_runs[0].lease = "lease-a"; await step();
    tables.first_month_runs[0].lease = "lease-a"; await step();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(tables.first_month_jobs[1].status).toBe("ready");
  });
  it("makes one deliberate retry for unavailable sources, without spending it on successful preparation", async () => {
    jobs(1, false);
    prepare.mockImplementationOnce(async (db, value) => savePacket(db, value, "unavailable"));
    await step();
    expect(tables.first_month_jobs[0]).toMatchObject({status:"queued",attempts:1});
    tables.first_month_runs[0].lease = "lease-a"; await step();
    expect(prepare).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({keywordId:"keyword0"}), {retryUnavailable:true});
    expect(generate).not.toHaveBeenCalled();
    expect(tables.first_month_jobs[0]).toMatchObject({status:"queued",attempts:1});
    tables.first_month_runs[0].lease = "lease-a"; await step();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(tables.first_month_jobs[0]).toMatchObject({status:"ready",attempts:2});
  });
  it("stops after two unavailable preparation attempts", async () => {
    jobs(1, false);
    prepare.mockImplementation(async (db, value) => savePacket(db, value, "unavailable"));
    await step();
    tables.first_month_runs[0].lease = "lease-a"; await step();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(generate).not.toHaveBeenCalled();
    expect(tables.first_month_jobs[0]).toMatchObject({status:"failed",attempts:2});
  });
  it("refuses stale buyer or locale qualification before preparing sources", async () => {
    jobs(1);
    tables.workspaces[0].business_profile = {primaryBuyer:"Enterprise developers"};
    tables.workspaces[0].language = "it";
    await step();
    expect(prepare).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(tables.first_month_jobs[0].status).toBe("failed");
  });
});

it("does not automatically regenerate a candidate with a known quality failure",async()=>{
 const {DraftReadinessError}=await import("@/lib/content/draft-readiness");jobs(1);generate.mockRejectedValue(new DraftReadinessError("material-findings"));
 await step();expect(tables.first_month_jobs[0]).toMatchObject({status:"failed",attempts:1});expect(tables.articles).toHaveLength(1);expect(wake).toHaveBeenCalled();
});
