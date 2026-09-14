import { beforeEach, expect, it, vi } from "vitest";
import { reviewFirstDraft } from "../first-draft-review";
import { reviewApprovedOutput } from "../approved-output";
import { claimPassages, hasCompleteSentenceCoverage } from "../claim-verification";

const { ask, prompts } = vi.hoisted(() => ({ ask: vi.fn(), prompts: [] as Array<{ operation: string; prompt: string }> }));
vi.mock("@/lib/keyword-research/buyer-model", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/keyword-research/buyer-model")>(),
  askStructured: ask,
}));
const evidence = [{ url: "https://example.test/guide", title: "Workflow guide", headings: [], text: "Ask the team which updates matter." }];
let flagRepetition = false;

beforeEach(() => {
  flagRepetition = false;
  prompts.length = 0;
  ask.mockReset().mockImplementation(async (operation: string, prompt: string) => {
    prompts.push({ operation, prompt });
    if (operation === "article/approved-output-review") return JSON.stringify({
      productChecked: true, qualitativeChecked: true, structureChecked: true, resolutions: [],
      findings: flagRepetition ? [{ category: "repetition", severity: "editorial", passageIndex: 1, reason: "The paragraph is repeated verbatim." }] : [],
    });
    const { assignedPassages } = JSON.parse(prompt.split("\n").at(-1)!);
    return JSON.stringify({ passages: assignedPassages.map((passage: { passageIndex: number; sentences: Array<{ sentenceIndex: number; text: string }> }) => ({
      passageIndex: passage.passageIndex,
      claims: passage.sentences.filter(sentence => sentence.text === "Beacon guarantees profit.").map(sentence => ({ claimId: "guarantee", sentenceIndex: sentence.sentenceIndex, quote: sentence.text, category: "product", verdict: "unsupported", reason: "The source establishes no profit guarantee.", evidence: [], contradiction: "" })),
      coverage: passage.sentences.map(sentence => ({ sentenceIndex: sentence.sentenceIndex, claimIds: sentence.text === "Beacon guarantees profit." ? ["guarantee"] : [], nonFactualReason: sentence.text === "Beacon guarantees profit." ? "" : "Article title or ordinary editorial advice." })),
    })) });
  });
});

it("audits the approved headline rather than a factual claim removed from the returned draft", async () => {
  const result = await reviewFirstDraft("<h1>Beacon guarantees profit.</h1><p>Ask the team which updates matter.</p>", { title: "Choose a workflow", evidence });
  expect(result.html).toBe("<h1>Choose a workflow</h1><p>Ask the team which updates matter.</p>");
  expect(prompts).toHaveLength(2);
  expect(prompts.every(({ prompt }) => !prompt.includes("Beacon guarantees profit."))).toBe(true);
  expect(result.report.status).toBe("checked");
  expect(result.report.findings).toEqual([]);
  expect(result.report.claimVerification?.sentenceInventory?.map(sentence => sentence.text)).toEqual(claimPassages(result.html));
  expect(hasCompleteSentenceCoverage(result.report.claimVerification!)).toBe(true);
});

it("keeps the reviewed paragraph snapshot when the parallel editorial review flags a duplicate", async () => {
  flagRepetition = true;
  const html = "<h1>Choose a workflow</h1><p>Ask the team which updates matter.</p><p>Ask the team which updates matter.</p>";
  const result = await reviewFirstDraft(html, { title: "Choose a workflow", evidence });
  expect(result.html).toBe(html);
  expect(result.report.findings[0]).toMatchObject({ category: "repetition", severity: "editorial", removed: false });
  expect(result.report.claimVerification?.sentenceInventory?.map(sentence => sentence.text)).toEqual(claimPassages(result.html));
  expect(result.report.claimVerification?.totalPassages).toBe(3);
});

it("preserves duplicate cleanup for standalone legacy editorial reviews", async () => {
  flagRepetition = true;
  const result = await reviewApprovedOutput("<h1>Choose a workflow</h1><p>Ask the team which updates matter.</p><p>Ask the team which updates matter.</p>", { evidence });
  expect(result.html).toBe("<h1>Choose a workflow</h1><p>Ask the team which updates matter.</p>");
  expect(result.report.findings[0]).toMatchObject({ category: "repetition", removed: true });
});
