#!/usr/bin/env tsx
/** Real-provider quality benchmark. Persists ONLY to loopback Supabase.
 * npx tsx scripts/onboarding-quality.ts --provider-env=/path/to/env --local-env=/path/to/local-env --out=/tmp/quality --domain=altorank.co
 * Optional --keyword=... is a labelled regression replay, never discovery evidence.
 * Provider keys are allowlisted; no billing, email, CMS or image credentials load.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const flag = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const report: Record<string, unknown> = { startedAt: new Date().toISOString() };
let output = '';
const save = () => { if (output) writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2), { mode: 0o600 }); };
async function main() {
  const providerPath = flag('provider-env'); const localPath = flag('local-env');
  if (!providerPath || !localPath || !flag('out')) throw new Error('Require --provider-env, --local-env and --out');
  const providers = parseEnv(readFileSync(providerPath, 'utf8'));
  const local = parseEnv(readFileSync(localPath, 'utf8'));
  const url = local.API_URL;
  if (!url || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Refusing a non-loopback database');
  // Clear inherited integration credentials before importing any app modules.
  for (const key of Object.keys(process.env)) if (/SUPABASE|ANTHROPIC|OPENAI|DATAFORSEO|STRIPE|RESEND|YOUTUBE|E2E_STUBS|SIMULAT/i.test(key)) delete process.env[key];
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'ANTHROPIC_MODEL_STRUCTURED', 'ANTHROPIC_MODEL_EDITORIAL', 'DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD', 'DATAFORSEO_API_KEY']) {
    if (providers[key]) process.env[key] = providers[key];
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL = url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = local.SERVICE_ROLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = local.ANON_KEY;
  if (!process.env.ANTHROPIC_API_KEY || !local.SERVICE_ROLE_KEY) throw new Error('Missing model or local database credential');
  output = resolve(flag('out')!); mkdirSync(output, { recursive: true });
  const domain = flag('domain') ?? 'altorank.co'; const language = flag('language') ?? 'en';
  const locationCode = Number(flag('location') ?? (language === 'it' ? 2380 : 2840));
  report.domain = domain;
  report.scope = 'Live profile, discovery, buyer fit, SERP qualification and generateArticle with local persistence. No browser, payment, CMS publishing or image-provider test.';
  report.selectionPolicy = flag('keyword') ? 'Explicit keyword regression replay; not discovery evidence' : 'Production domain analysis and recommendation scoring, coverage shortlist and bounded qualification; highest-ranked distinct qualified recommendation';
  const { createClient } = await import('@supabase/supabase-js');
  const { inferBusinessProfileDetailed } = await import('@/lib/onboarding/business-profile');
  const { analyseDomain } = await import('@/lib/audit/domain-analysis');
  const { recommendKeywords } = await import('@/lib/seo/recommendations');
  const { qualifyOpportunities } = await import('@/lib/keyword-research/opportunity');
  const { generateArticle } = await import('@/lib/content/generate');
  const { selectArticleQuestions } = await import('@/lib/ai/article-questions');
  const { setSpendReporter } = await import('@/lib/seo/client');
  const { recordSpend } = await import('@/lib/billing/spend');
  const db = createClient(url, local.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const resume = flag('resume-report') ? JSON.parse(readFileSync(flag('resume-report')!, 'utf8')) : null;
  if (resume && resume.domain !== domain) throw new Error('Resume domain mismatch');
  const accountId = randomUUID(); const workspaceId = resume?.workspaceId ?? randomUUID();
  if (resume) { Object.assign(report, resume, { resumedAt: new Date().toISOString(), timingInvalidated: 'Local database stopped during the initial run; excludes latency comparison' }); delete report.error; }
  const checked = <T extends { error: { message: string } | null }>(r: T) => { if (r.error) throw new Error(r.error.message); return r; };
  // Read schema before spending on research. This does not touch an existing workspace.
  checked(await db.from('keywords').select('opportunity,research_evidence').limit(0));
  setSpendReporter(({ operation, costUsd }) => { void recordSpend(db, { provider: 'dataforseo', operation, costUsd, workspaceId }); });
  report.costLimitations = 'Provider usage is recorded per workspace; a replay reuses the saved profile and excludes its original inference cost.';
  const candidateBaseline = flag('candidate-baseline') ? JSON.parse(readFileSync(flag('candidate-baseline')!, 'utf8')) : null;
  if (candidateBaseline && candidateBaseline.domain !== domain) throw new Error('Baseline domain mismatch');
  if (!resume) {
  checked(await db.from('accounts').insert({ id: accountId, name: 'Local quality benchmark', slug: `quality-${accountId}` }));
  checked(await db.from('workspaces').insert({ id: workspaceId, account_id: accountId, name: `Quality ${domain}`, domain, status: 'setup', language, location_code: locationCode, ai_provider: 'claude' }));
  } else checked(await db.from('workspaces').select('id').eq('id', workspaceId).single());
  report.workspaceId = workspaceId; save();
  const spend = { supabase: db, workspaceId };
  report.inference = resume?.inference ?? candidateBaseline?.inference ?? await inferBusinessProfileDetailed(domain, spend);
  const profile = (report.inference as Awaited<ReturnType<typeof inferBusinessProfileDetailed>>).profile;
  if (!profile) throw new Error('No usable inferred business profile');
  checked(await db.from('workspaces').update({business_profile: profile}).eq('id', workspaceId));
  save(); console.log('Profile ready', domain);
  if (flag('recovery-baseline')) {
    const baseline = JSON.parse(readFileSync(flag('recovery-baseline')!, 'utf8'));
    const { recoverBuyerSeeds } = await import('@/lib/keyword-research/buyer-seeds');
    const { fetchTermMetrics } = await import('@/lib/keyword-research/metrics');
    const seeds = await recoverBuyerSeeds(profile, baseline.discovery.seeds.seeds, { spend });
    const metrics = await fetchTermMetrics(seeds, { languageCode: language, locationCode });
    report.recoveryProbe = { attempted: baseline.discovery.seeds.seeds, seeds, metrics: [...metrics.values()] };
    report.scope = 'Live recovery replay from saved failed seed set and exact keyword overview; no draft generated';
    save(); console.log('Recovery probe', report.recoveryProbe); return;
  }
  let terms: Array<{ keyword: string; volume: number | null; difficulty: number | null; cpc: number | null; sourceUrl?: string | null }>;
  if (candidateBaseline) {
    terms = candidateBaseline.qualification.map((q: { term: string }) => {
      const candidate = candidateBaseline.candidates?.find((c: { term: string }) => c.term === q.term) ?? candidateBaseline.discovery?.fromIdeas?.find((c: { keyword: string }) => c.keyword === q.term);
      return { keyword: q.term, volume: candidate?.unmeasured ? null : candidate?.volume ?? null, difficulty: candidate?.difficulty ?? null, cpc: candidate?.cpc ?? null };
    });
    report.scope = 'Controlled replay of saved profile and discovered candidates through live qualification and finished draft; discovery not rerun';
    report.selectionPolicy = 'First qualified candidate in unchanged saved candidate order';
  } else if (flag('keyword')) terms = [{ keyword: flag('keyword')!, volume: null, difficulty: null, cpc: null }];
  else if (resume?.analysis) { terms = []; }
  else {
    report.analysis = await analyseDomain({ domain, profile, supabase: db, workspaceId, locale: language, locationCode, maxPages: 3, deferPageSpeed: true });
    terms = [];
    save();
  }
  const replay = Boolean(candidateBaseline || flag('keyword'));
  if (replay && !terms.length) throw new Error('No regression candidates');
  const rows = replay ? terms.map(t => ({ id: randomUUID(), workspace_id: workspaceId, term: t.keyword, volume: t.volume, difficulty: t.difficulty, cpc: t.cpc, source_url: t.sourceUrl ?? null, status: 'new' })) : checked(await db.from('keywords').select('id,workspace_id,term,volume,difficulty,cpc,source_url,status,research_evidence').eq('workspace_id', workspaceId)).data ?? [];
  if (replay) checked(await db.from('keywords').insert(rows));
  report.candidates = rows;
  const recommendations = replay ? null : await recommendKeywords(db, workspaceId, { limit: 1000, qualify: true, onProgress: (items, results) => {
    const briefs = items.flatMap(item => results.get(item.id)?.status === 'qualified' ? [{term:item.term,brief:results.get(item.id)}] : []);
    if (briefs.length && report.timeToFirstUsefulResultMs === undefined) {
      report.timeToFirstUsefulResultMs = Date.now() - Date.parse(report.startedAt as string);
      report.firstUsefulBriefs = briefs; save();
    }
  } });
  report.recommendations = recommendations;

  const opportunities = recommendations ? new Map(recommendations.flatMap((r) => r.keywordId && r.opportunity ? [[r.keywordId, r.opportunity] as const] : [])) : await qualifyOpportunities(db, workspaceId, rows, { domain, business: profile, languageCode: language, locationCode });
  report.qualification = [...opportunities].map(([id, o]) => ({ id, term: rows.find(r => r.id === id)?.term, ...o })); save();
  const first = recommendations?.find(r => r.action === 'write' && r.quality === 'ok' && r.opportunity?.status === 'qualified');
  const selected = recommendations ? rows.find(r => r.id === first?.keywordId) : rows.find(r => opportunities.get(r.id)?.status === 'qualified');
  if (!selected) throw new Error('No qualified topic; refusing to invent a replacement');
  report.timeToFirstUsefulResultMs ??= Date.now() - Date.parse(report.startedAt as string);
  report.selected = selected; console.log('Writing', selected.term); save();
  // Live semantic regression independently replays the exact observed bad PAA.
  if (flag('keyword') === 'therapy practice website') {
    report.therapyQuestionRegression = await selectArticleQuestions([
      'Can ChatGPT do therapy?', 'What is the 2 year rule in therapy?',
      'How much does a therapist website cost?', 'How do I add online booking to my therapy website?',
    ], { keyword: selected.term, business: profile, brief: opportunities.get(selected.id) }, { spend }); save();
  }
  const start = Date.now();
  const article = await generateArticle({ supabase: db, workspaceId, keyword: selected.term, keywordId: selected.id, autonomous: true, callerEmail: null,
    onResearch: research => { report.research = research; save(); console.log('Research ready; relevant questions', research.peopleAlsoAsk.length); },
  });
  report.article = article; report.draftSeconds = (Date.now() - start) / 1000;
  report.finishedAt = new Date().toISOString();
  report.spend = checked(await db.from('provider_spend').select('provider,operation,cost_usd,input_tokens,output_tokens').eq('workspace_id', workspaceId)).data;
  writeFileSync(`${output}/article.html`, article.html, { mode: 0o600 });
  save(); console.log('Complete', { title: article.title, words: article.wordCount, seconds: report.draftSeconds, factCheck: article.factCheck.verdict });
}
main().catch(error => { report.error = error instanceof Error ? error.message : String(error); save(); console.error(report.error); process.exitCode = 1; });
