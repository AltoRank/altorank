#!/usr/bin/env tsx
/** Historical generic-writer comparison. Same saved business, brief, research and links.
 * --baseline=/path/to/live-report.json --old-checkout=/path/to/baseline --provider-env=/path/to/env --out=/tmp/compare
 * Only Anthropic credentials are read. No database writes or publishing.
 * This intentionally exercises buildSystemPrompt without firstDraft inputs.
 * It cannot validate the current onboarding writer, source readiness or review.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const flag = (key: string) => process.argv.find(a => a.startsWith(`--${key}=`))?.slice(key.length + 3);
async function main() {
  for (const key of ["baseline", "old-checkout", "provider-env", "out"]) if (!flag(key)) throw Error(`Missing --${key}`);
  console.log("Historical generic-writer comparison; does not evaluate the current selected onboarding draft flow.");
  const env = parseEnv(readFileSync(flag("provider-env")!, "utf8"));
  for (const key of Object.keys(process.env)) if (/ANTHROPIC|OPENAI|DATAFORSEO|STRIPE|RESEND|SUPABASE|E2E_STUBS/.test(key)) delete process.env[key];
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "ANTHROPIC_MODEL_STRUCTURED", "ANTHROPIC_MODEL_EDITORIAL"]) if (env[key]) process.env[key] = env[key];
  const baseline = JSON.parse(readFileSync(flag("baseline")!, "utf8"));
  const article = baseline.articles[0]; const profile = baseline.workspaces[0].business_profile;
  const keyword = baseline.keywords.find((k: { term: string }) => k.term === article.keyword);
  const out = resolve(flag("out")!); mkdirSync(out, {recursive:true});
  const { buildSystemPrompt, buildUserMessage } = await import("@/lib/ai/prompts");
  const old = await import(pathToFileURL(resolve(flag("old-checkout")!, "apps/web/lib/ai/prompts.ts")).href);
  const { supportedCapabilities } = await import("@/lib/onboarding/profile-focus");
  const { anthropicModel } = await import("@/lib/ai/models");
  const { anthropicCost } = await import("@/lib/billing/spend");
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const { tiptapToHtml } = await import("@/lib/cms/html");
  const html = tiptapToHtml(article.content);
  const targets = [...html.matchAll(/<a\b[^>]*href="(https:\/\/altorank.co\/blog\/[^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi)].map(m => ({keyword:m[2].replace(/<[^>]+>/g,""),title:m[2].replace(/<[^>]+>/g,"")}));
  const prompt = { keyword: article.keyword, title:article.title, language:"English", research: article.research, site:profile, internalLinkTargets: targets,
    brief:{ instructions:`VERIFIED PRODUCT CAPABILITIES: ${JSON.stringify(supportedCapabilities(profile))}. Preserve the approved headline exactly. APPROVED EDITORIAL BRIEF: ${JSON.stringify(keyword.opportunity)}. Answer the specific buying job; do not invent product claims.`, answers:[], articleType:article.article_type, articleSubtype:article.article_subtype, expectedLength:"auto" },
  };
  writeFileSync(`${out}/input.json`, JSON.stringify(prompt,null,2));
  const client = new Anthropic({apiKey:process.env.ANTHROPIC_API_KEY,maxRetries:0});
  const results = await Promise.all([ ["before",old.buildSystemPrompt(prompt)], ["after",buildSystemPrompt(prompt)] ].map(async ([label,system]) => {
    const started = Date.now(); const model = anthropicModel("content");
    writeFileSync(`${out}/${label}-prompt.txt`,system);
    const stream = client.messages.stream({model,max_tokens:64000,system,messages:[{role:"user",content:buildUserMessage(prompt)}]});
    const message = await stream.finalMessage();
    if (message.stop_reason === "max_tokens") throw Error(`${label} truncated`);
    const text = message.content.flatMap(b => b.type === "text" ? [b.text] : []).join("");
    writeFileSync(`${out}/${label}.html`,text);
    return {label,seconds:(Date.now()-started)/1000,words:text.replace(/<[^>]+>/g," ").split(/\s+/).length,model,usage:message.usage,costUsd:anthropicCost(model,message.usage.input_tokens,message.usage.output_tokens)};
  }));
  writeFileSync(`${out}/results.json`,JSON.stringify({contract:"historical-generic-writer",scope:"One sample per generic prompt with identical saved inputs and no firstDraft source packet. Does not exercise the current selected onboarding writer, source readiness, claim review or route flow. Not a conversion experiment.",results},null,2));
  console.log(results.map(r=>({label:r.label,words:r.words,seconds:r.seconds,cost:r.costUsd})));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
