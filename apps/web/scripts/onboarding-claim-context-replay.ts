#!/usr/bin/env tsx
/** Preregistered same-source context calibration. Anthropic only, production
 * reasoning defaults, no DB/source fetching. At most eight calls across three
 * fixtures, including only verifyDraftClaims' existing bounded recovery.
 * --source-run=/saved/writer/run --provider-env=/path --out=/fresh/path */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { PageExtract } from "@/lib/keyword-research/page-evidence";
import type { ModelObservation } from "@/lib/keyword-research/buyer-model";
import type { ClaimVerification } from "@/lib/content/claim-verification";

const flag = (name: string) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Fixture = { id: string; origin: string; html: string; expected: string; targetQuote?: string; requiredFinding: string };

async function main() {
  for (const key of ["source-run", "provider-env", "out"]) if (!flag(key)) throw Error(`Missing --${key}`);
  const out = resolve(flag("out")!);
  if (existsSync(out)) throw Error("Use a fresh output directory to preserve every attempt.");
  const provider = parseEnv(readFileSync(flag("provider-env")!, "utf8"));
  for (const key of Object.keys(process.env)) if (/SUPABASE|ANTHROPIC|OPENAI|DATAFORSEO|STRIPE|RESEND|E2E_STUBS/i.test(key)) delete process.env[key];
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL_EDITORIAL"]) if (provider[key]) process.env[key] = provider[key];
  if (!process.env.ANTHROPIC_API_KEY) throw Error("Anthropic credentials required.");
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const saveText = (file: string, value: string) => writeFileSync(`${out}/${file}`, value, { mode: 0o600 });
  const save = (file: string, value: unknown) => saveText(file, JSON.stringify(value, null, 2));
  const fixturePath = "scripts/fixtures/claim-context-relationships.json";
  const fixtureText = readFileSync(fixturePath, "utf8");
  const fixtures = JSON.parse(fixtureText) as { version: number; cases: Fixture[] };
  if (fixtures.version !== 1 || fixtures.cases.length !== 3) throw Error("Expected the three preregistered context fixtures.");
  saveText("preregistered-fixtures.json", fixtureText);
  const sourceText = readFileSync(`${flag("source-run")}/input-sources.json`, "utf8");
  const writerText = readFileSync(`${flag("source-run")}/writer-input.json`, "utf8");
  const rawText = readFileSync(`${flag("source-run")}/raw-writer.html`, "utf8");
  const evidence = JSON.parse(sourceText) as PageExtract[];
  const brief = JSON.parse(writerText).firstDraft.brief as unknown;
  saveText("original-input-sources.json", sourceText);
  saveText("original-writer-input.json", writerText);
  saveText("original-raw-writer.html", rawText);
  const files = ["lib/content/claim-verification.ts", "lib/content/draft-evidence.ts", "lib/keyword-research/buyer-model.ts", "lib/seo/request-context.ts", "lib/ai/models.ts", "lib/audit/html-utils.ts", fixturePath, "scripts/onboarding-claim-context-replay.ts"];
  const before = Object.fromEntries(files.map(file => {
    const value = readFileSync(file, "utf8");
    saveText(file.replaceAll("/", "_") + ".txt", value);
    return [file, hash(value)];
  }));
  const inputHashes: Record<string, string> = {};
  for (const fixture of fixtures.cases) {
    mkdirSync(`${out}/${fixture.id}`, { mode: 0o700 });
    const input = JSON.stringify({ ...fixture, evidence, brief }, null, 2);
    saveText(`${fixture.id}/input.json`, input);
    saveText(`${fixture.id}/input.html`, fixture.html);
    inputHashes[fixture.id] = hash(input);
  }
  const { verifyDraftClaims, hasCompleteSentenceCoverage, CLAIM_COVERAGE_VERSION } = await import("@/lib/content/claim-verification");
  const { withModelObserver } = await import("@/lib/keyword-research/buyer-model");
  const { ResearchBudget, withResearchBudget } = await import("@/lib/seo/request-context");
  const outer = new ResearchBudget(8, 5 * 60_000);
  const observations: Array<ModelObservation & { caseId: string }> = [];
  const results: Array<{ id: string; elapsedMs: number; providerCalls: number; completeCoverage: boolean; targetSentenceFindings: ClaimVerification["claims"]; result: ClaimVerification }> = [];
  const metadata = { scope: "Preregistered development calibration only, not a blinded benchmark or full onboarding test. Negative requires human confirmation of the actual entity-relationship error; unrelated findings do not pass it. Positive cases require checked coverage and no material findings.", startedAt: new Date().toISOString(), revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), reasoningConfiguration: "Production defaults; no reasoning override.", contractVersion: CLAIM_COVERAGE_VERSION, limits: { totalProviderCalls: 8, caseProviderCalls: 8, caseDeadlineMs: 90_000 }, inputHashes, originalHashes: { sources: hash(sourceText), writer: hash(writerText), html: hash(rawText) }, implementationHashesBefore: before };
  let stage = "preregistered";
  const persist = () => {
    save("model-observations.json", observations);
    save("report.json", { ...metadata, stage, providerCalls: outer.calls, knownCostUsd: observations.reduce((n, o) => n + (o.costUsd ?? 0), 0), results });
  };
  persist();
  try {
    await withModelObserver(observation => { observations.push({ caseId: stage, ...observation }); persist(); }, () => withResearchBudget(outer, async () => {
      for (const fixture of fixtures.cases) {
        if (outer.exhausted) break;
        stage = fixture.id;
        const started = Date.now();
        const budget = new ResearchBudget(8, 90_000);
        const result = await withResearchBudget(budget, () => verifyDraftClaims(fixture.html, { evidence, brief }));
        const target = result.sentenceInventory?.find(s => fixture.targetQuote && s.text.includes(fixture.targetQuote));
        const targetSentenceFindings = target ? result.claims.filter(c => c.passageIndex === target.passageIndex && c.sentenceIndex === target.sentenceIndex && ["unsupported", "contradicted"].includes(c.verdict)) : [];
        const row = { id: fixture.id, elapsedMs: Date.now() - started, providerCalls: budget.calls, completeCoverage: hasCompleteSentenceCoverage(result), targetSentenceFindings, result };
        results.push(row);
        save(`${fixture.id}/output.json`, row);
        save(`${fixture.id}/model-observations.json`, observations.filter(o => o.caseId === fixture.id));
        persist();
        console.log(JSON.stringify({ id: fixture.id, status: result.status, completeCoverage: row.completeCoverage, calls: budget.calls, materialFindings: result.claims.filter(c => ["unsupported", "contradicted"].includes(c.verdict)).length, targetSentenceFindings: targetSentenceFindings.length }));
      }
    }), { includeResponse: true });
  } finally {
    const after = Object.fromEntries(files.map(file => [file, hash(readFileSync(file, "utf8"))]));
    save("implementation-hashes.json", { before, after, allSnapshottedFilesUnchanged: files.every(file => before[file] === after[file]) });
    stage = "complete";
    persist();
    save("completion.json", { finishedAt: new Date().toISOString(), providerCalls: outer.calls, completedCases: results.map(r => r.id), notRun: fixtures.cases.filter(f => !results.some(r => r.id === f.id)).map(f => f.id) });
  }
  console.log(`Saved bounded context diagnostics: ${out}`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Context replay failed."); process.exitCode = 1; });
