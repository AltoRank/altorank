#!/usr/bin/env tsx
/** Saved-input claim calibration. Anthropic only; no database, fetches or writing.
 * --reports=/path/cohort --provider-env=/path --out=/fresh/path
 * Optional --experimental-reasoning=disabled changes this diagnostic only.
 * Development diagnostics, not a blinded benchmark or end-to-end onboarding test. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { PageExtract } from "@/lib/keyword-research/page-evidence";
import type { ModelObservation } from "@/lib/keyword-research/buyer-model";
import type { ClaimVerification } from "@/lib/content/claim-verification";

const flag = (name: string) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
type ReplayInput = { id: string; origin: string; html: string; evidence: PageExtract[]; brief: unknown; expectations: string[] };
const source = (text: string): PageExtract => ({ url: "https://beacon.example.test/guide", title: "Fictional Beacon documentation — evaluator-authored fixture", headings: [], text });

async function main() {
  for (const key of ["reports", "provider-env", "out"]) if (!flag(key)) throw Error(`Missing --${key}`);
  const out = resolve(flag("out")!);
  if (existsSync(out)) throw Error("Use a fresh output directory to preserve all attempts.");
  const reasoningOverride = flag("experimental-reasoning");
  if (reasoningOverride !== undefined && reasoningOverride !== "disabled") throw Error("Only --experimental-reasoning=disabled is supported; omit it to use production defaults.");
  const provider = parseEnv(readFileSync(flag("provider-env")!, "utf8"));
  for (const key of Object.keys(process.env)) if (/SUPABASE|ANTHROPIC|OPENAI|DATAFORSEO|STRIPE|RESEND|E2E_STUBS/i.test(key)) delete process.env[key];
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL_EDITORIAL"]) if (provider[key]) process.env[key] = provider[key];
  if (reasoningOverride) process.env.ANTHROPIC_EDITORIAL_REASONING = reasoningOverride;
  if (!process.env.ANTHROPIC_API_KEY) throw Error("Anthropic credentials required.");
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const save = (path: string, value: unknown) => writeFileSync(`${out}/${path}`, JSON.stringify(value, null, 2), { mode: 0o600 });
  const files = ["lib/content/claim-verification.ts", "lib/content/draft-evidence.ts", "lib/keyword-research/buyer-model.ts", "lib/seo/request-context.ts", "lib/ai/models.ts", "lib/audit/html-utils.ts"];
  const before = Object.fromEntries(files.map(file => {
    const text = readFileSync(file, "utf8");
    writeFileSync(`${out}/${file.replaceAll("/", "_")}.txt`, text, { mode: 0o600 });
    return [file, sha256(text)];
  }));
  const inputs: ReplayInput[] = ["basecamp", "linear"].map(id => {
    const reportText = readFileSync(`${flag("reports")}/${id}/report.json`, "utf8");
    const report = JSON.parse(reportText);
    mkdirSync(`${out}/${id}`, { mode: 0o700 });
    for (const file of ["report.json", "model-observations.json", "withheld-candidate.html"]) writeFileSync(`${out}/${id}/original-${file}`, readFileSync(`${flag("reports")}/${id}/${file}`), { mode: 0o600 });
    return { id, origin: "Frozen v2 actual withheld candidate and exact retained source packet", html: readFileSync(`${flag("reports")}/${id}/withheld-candidate.html`, "utf8"), evidence: report.articles[0].research.draftSources, brief: report.selected.brief,
      expectations: id === "basecamp" ? ["Acknowledge the real-time outcome sentence separately from adjacent ordinary advice; manual status updates do not establish real-time tracking.", "Retain supported product features and nonfactual suggestions."] : ["Detect the unsupported fastest-way comparison.", "Assess the entire self-sustaining automation assertion, including documented manual triggers, rather than only its sourced components.", "Read the Salesforce data sentence in its explicit conditional context; do not invent a universal Salesforce prerequisite."] };
  });
  const fixtureBrief = { angle: "Set up a clear feedback workflow", audience: "Small product teams", buyingJob: "Turn feedback into trackable work" };
  inputs.push(
    { id: "omitted-second-sentence", origin: "Evaluator-authored generic regression", brief: fixtureBrief, html: "<p>Ask the team which updates they need before choosing a workflow. Beacon guarantees every task stays accurate in real time without anyone updating it.</p>", evidence: [source("Team members update each task's status manually. Beacon displays the last saved status.")], expectations: ["First sentence nonfactual advice; second sentence unsupported or contradicted product outcome. Both sentences acknowledged."] },
    { id: "supported-plus-advice", origin: "Evaluator-authored balanced negative control", brief: fixtureBrief, html: "<p>Beacon lets you assign an owner to each task. Start with a small project and ask the team whether the owner is clear.</p>", evidence: [source("Each task can be assigned to one owner.")], expectations: ["Owner feature supported; small-project advice nonfactual; no unsupported or contradicted finding."] },
    { id: "hypothetical-input-vs-product-behavior", origin: "Evaluator-authored mixed control", brief: fixtureBrief, html: "<p>Imagine a customer asks for a weekly summary. Write a hypothetical task titled Add a weekly summary.</p><p>If that customer sends an email, Beacon automatically identifies the request and assigns it to the correct engineer.</p>", evidence: [source("Users create tasks manually and select an owner. The email integration imports the email text into a new unassigned draft.")], expectations: ["Hypothetical input and editorial example remain nonfactual; conditional wording does not exempt undocumented automatic assignment."] },
    { id: "same-sentence-supported-plus-guarantee", origin: "Evaluator-authored assertion split regression", brief: fixtureBrief, html: "<p>Beacon lets users set a due date and guarantees that no task will ever miss its deadline.</p>", evidence: [source("Users can set a due date on a task. Overdue tasks remain visible until a team member marks them complete.")], expectations: ["Separate the supported due-date feature from the unsupported or contradicted no-missed-deadline guarantee within one sentence."] },
    { id: "conditional-customer-data-setup", origin: "Evaluator-authored context preservation control", brief: fixtureBrief, html: "<p>If your team tracks customer tier in Salesforce, connect that data before writing tier-based prioritization rules, since those rules depend on that customer data being present. For a team that does not use customer tiers, choose a priority manually.</p>", evidence: [source("Beacon can sync customer tier from Salesforce. Users can create prioritization rules based on the synced customer-tier field. Users can also set task priority manually.")], expectations: ["Conditional setup advice and its scoped data dependency are supported or nonfactual. Do not read this as saying all prioritization requires Salesforce."] },
  );
  for (const input of inputs) {
    if (!existsSync(`${out}/${input.id}`)) mkdirSync(`${out}/${input.id}`, { mode: 0o700 });
    save(`${input.id}/input.json`, input);
  }
  const { verifyDraftClaims, hasCompleteSentenceCoverage, CLAIM_COVERAGE_VERSION } = await import("@/lib/content/claim-verification");
  const { withModelObserver } = await import("@/lib/keyword-research/buyer-model");
  const { ResearchBudget, withResearchBudget } = await import("@/lib/seo/request-context");
  const outer = new ResearchBudget(24, 12 * 60_000);
  const observations: Array<ModelObservation & { caseId: string }> = [];
  const results: Array<{ id: string; elapsedMs: number; providerCalls: number; completeCoverage: boolean; result: ClaimVerification }> = [];
  let stage = "setup";
  const metadata = { scope: "Saved-input development diagnostics only. No database, source fetching, article generation, or human benchmark. All generic examples are evaluator-authored fictional fixtures.", experimentalReasoningOverride: reasoningOverride ?? null, reasoningConfiguration: reasoningOverride ? "Evaluation-only explicit CLI override; production defaults unchanged." : "Production default (no reasoning override).", startedAt: new Date().toISOString(), revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), contractVersion: CLAIM_COVERAGE_VERSION, limits: { totalProviderCalls: 24, caseProviderCalls: 8, caseDeadlineMs: 90_000 }, implementationHashesBefore: before };
  const persist = () => { save("model-observations.json", observations); save("report.json", { ...metadata, stage, providerCalls: outer.calls, knownCostUsd: observations.reduce((sum, item) => sum + (item.costUsd ?? 0), 0), results }); };
  persist();
  try {
    await withModelObserver(observation => { observations.push({ caseId: stage, ...observation }); persist(); }, () => withResearchBudget(outer, async () => {
      for (const input of inputs) {
        if (outer.exhausted) break;
        stage = input.id;
        const started = Date.now();
        const budget = new ResearchBudget(8, 90_000);
        const result = await withResearchBudget(budget, () => verifyDraftClaims(input.html, { evidence: input.evidence, brief: input.brief }));
        const row = { id: input.id, elapsedMs: Date.now() - started, providerCalls: budget.calls, completeCoverage: hasCompleteSentenceCoverage(result), result };
        results.push(row);
        save(`${input.id}/output.json`, row);
        save(`${input.id}/model-observations.json`, observations.filter(item => item.caseId === input.id));
        persist();
        console.log(JSON.stringify({ id: input.id, status: result.status, completeCoverage: row.completeCoverage, calls: budget.calls, findings: result.claims.filter(claim => ["unsupported", "contradicted"].includes(claim.verdict)).length }));
      }
    }), { includeResponse: true });
  } finally {
    const after = Object.fromEntries(files.map(file => [file, sha256(readFileSync(file, "utf8"))]));
    save("implementation-hashes.json", { before, after, claimImplementationUnchanged: before[files[0]] === after[files[0]], allSnapshottedFilesUnchanged: files.every(file => before[file] === after[file]) });
    stage = "complete";
    persist();
    save("completion.json", { finishedAt: new Date().toISOString(), completedCases: results.map(result => result.id), notRun: inputs.filter(input => !results.some(result => result.id === input.id)).map(input => input.id), providerCalls: outer.calls });
  }
  console.log(`Saved bounded claim diagnostics: ${out}`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Claim replay failed."); process.exitCode = 1; });
