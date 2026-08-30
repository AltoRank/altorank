#!/usr/bin/env tsx
/**
 * Generation pipeline smoke test.
 *
 *   npm run smoke -- "your keyword"
 *
 * Exercises the real path end to end: research -> prompt -> model -> fact
 * check. Everything except HTTP auth and the database write, which the route
 * owns.
 *
 * This exists because the pipeline can typecheck, pass 213 unit tests and still
 * be incapable of producing an article, which is exactly the state it was in
 * before the first key was added. Unit tests mock the model; this does not.
 *
 * It is also the answer to "did my BYOK setup work?" for self-hosters, which
 * matters for the $0 rung: ANTHROPIC_API_KEY is the only hard requirement, and
 * every other layer should degrade rather than fail. Running this proves that
 * claim on the user's own credentials instead of asserting it in a README.
 *
 * Deliberately short: 400 words, so a verification run costs very little.
 */

import { gatherArticleResearch } from "@/lib/seo/research";
import { buildSystemPrompt } from "@/lib/ai/prompts";
import { factCheckArticle } from "@/lib/ai/fact-check";
import { ClaudeProvider } from "@/lib/ai/claude";
import { anthropicModel } from "@/lib/ai/models";

const keyword = process.argv.slice(2).join(" ") || "agent ready website";
const WORDS = 400;

function heading(text: string): void {
  console.log(`\n${"=".repeat(64)}\n${text}\n${"=".repeat(64)}`);
}

async function main(): Promise<void> {
  heading("1. Credentials");
  const anthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  const dataForSeo = Boolean(
    process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD,
  );
  console.log(`  ANTHROPIC_API_KEY   ${anthropic ? "set" : "MISSING (required)"}`);
  console.log(`  DataForSEO          ${dataForSeo ? "set" : "absent (research will degrade)"}`);
  console.log(`  model               ${anthropicModel("content")}`);
  if (!anthropic) {
    console.error("\nANTHROPIC_API_KEY is required. Nothing else can run.");
    process.exit(1);
  }

  heading(`2. Research: "${keyword}"`);
  const t0 = Date.now();
  const research = await gatherArticleResearch({ keyword, locale: "en" });
  console.log(`  took ${Date.now() - t0}ms`);
  for (const l of research.layers) {
    console.log(`  [${l.status.padEnd(11)}] ${l.id.padEnd(17)} ${l.detail}`);
  }
  console.log(`\n  intent          ${research.intent.intent} (${research.intent.confidence} confidence)`);
  console.log(`  competitors     ${research.competitors.length}`);
  console.log(`  questions       ${research.peopleAlsoAsk.length}`);
  console.log(`  related terms   ${research.relatedKeywords.length}`);
  console.log(`  target length   ${research.recommendedWordCount} (${research.wordCountBasis})`);

  if (research.competitors.length) {
    console.log("\n  ranking now:");
    for (const c of research.competitors.slice(0, 5)) {
      console.log(`    - ${c.title.slice(0, 62)} (${c.domain})`);
    }
  }
  if (research.peopleAlsoAsk.length) {
    console.log("\n  people also ask:");
    for (const q of research.peopleAlsoAsk.slice(0, 5)) console.log(`    - ${q}`);
  }

  heading("3. Prompt");
  const system = buildSystemPrompt({
    keyword,
    language: "English",
    targetWordCount: WORDS,
    research,
  });
  console.log(`  ${system.length} chars`);
  const headings = system
    .split("\n\n")
    .map((s) => s.split("\n")[0])
    .filter((h) => /^[A-Z][A-Z &]+:$/.test(h));
  console.log(`  research-derived sections: ${headings.join(", ")}`);

  heading(`4. Generating (~${WORDS} words)`);
  const t1 = Date.now();
  const provider = new ClaudeProvider();
  const generator = provider.streamArticle({
    keyword,
    language: "English",
    targetWordCount: WORDS,
    research,
  });

  let chunks = 0;
  let result;
  while (true) {
    const next = await generator.next();
    if (next.done) {
      result = next.value;
      break;
    }
    chunks++;
    if (chunks % 20 === 0) process.stdout.write(".");
  }
  console.log(`\n  streamed ${chunks} chunks in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  console.log(`  title        ${result.title}`);
  console.log(`  words        ${result.wordCount}`);
  console.log(`  tokens       ${result.tokensUsed}`);
  console.log(`  meta         ${result.metaDescription.slice(0, 90)}`);

  heading("5. Fact check");
  const fc = factCheckArticle(result.html, research);
  console.log(`  verdict: ${fc.verdict} — ${fc.summary}`);
  for (const c of fc.claims.slice(0, 10)) {
    console.log(`    ${c.severity.padEnd(6)} ${c.status.padEnd(19)} "${c.text}"`);
    console.log(`           ${c.sentence.slice(0, 88)}`);
  }

  heading("6. Structure produced");
  for (const m of result.html.matchAll(/<(h[12])[^>]*>(.*?)<\/\1>/gi)) {
    console.log(`  ${m[1] === "h1" ? "" : "  "}${m[2].replace(/<[^>]+>/g, "").trim()}`);
  }

  console.log("\nPipeline OK.\n");
}

main().catch((err) => {
  console.error("\nFAILED:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
