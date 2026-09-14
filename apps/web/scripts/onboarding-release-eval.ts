#!/usr/bin/env tsx
/** Fresh-business evaluation of the production choice pipeline and selected-draft
 * generator. Loopback DB only; real model/search calls; no email, images or billing.
 * Automated selection accepts the inferred focus and first supported choice.
 * This is not an independent human judgment or a browser/checkout test.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
const flag = (name: string) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), scope: 'Fresh inferred focus, production choice pipeline, deferred voice/link preparation and source-verified selected draft; local persistence. Automated user choices; no browser, billing, images or email. Implementer assessment is not independent human approval.' };
let out = '';
const save = () => { if (out) writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2), { mode: 0o600 }); };
async function main() {
  for (const key of ['provider-env', 'local-env', 'out', 'domain']) if (!flag(key)) throw Error(`Missing --${key}`);
  const provider = parseEnv(readFileSync(flag('provider-env')!, 'utf8'));
  const local = parseEnv(readFileSync(flag('local-env')!, 'utf8'));
  if (!local.API_URL || !local.SERVICE_ROLE_KEY || !local.ANON_KEY) throw Error('Local database credentials missing');
  if (!['localhost', '127.0.0.1'].includes(new URL(local.API_URL).hostname)) throw Error('Loopback database required');
  for (const key of Object.keys(process.env)) if (/SUPABASE|ANTHROPIC|OPENAI|DATAFORSEO|STRIPE|RESEND|YOUTUBE|E2E_STUBS|SIMULAT|CRON_SECRET/i.test(key)) delete process.env[key];
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'ANTHROPIC_MODEL_STRUCTURED', 'ANTHROPIC_MODEL_EDITORIAL', 'DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD', 'DATAFORSEO_API_KEY']) if (provider[key]) process.env[key] = provider[key];
  process.env.NEXT_PUBLIC_SUPABASE_URL = local.API_URL;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = local.ANON_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = local.SERVICE_ROLE_KEY;
  if (!process.env.ANTHROPIC_API_KEY || !local.SERVICE_ROLE_KEY) throw Error('Required credentials missing');
  out = resolve(flag('out')!); mkdirSync(out, { recursive: true });
  const domain = flag('domain')!;
  const language = flag('language') ?? 'en';
  report.domain = domain; report.language = language; save();
  const { createClient } = await import('@supabase/supabase-js');
  const { inferBusinessProfileDetailed } = await import('@/lib/onboarding/business-profile');
  const { runOnboarding } = await import('@/lib/onboarding/pipeline');
  const { readSiteText } = await import('@/lib/onboarding/site-text');
  const { trainVoiceProfile } = await import('@/lib/voice/train');
  const { detectLinks } = await import('@/lib/linking/detect');
  const { generateArticle } = await import('@/lib/content/generate');
  const { fulfilPlannedEntry } = await import('@/lib/onboarding/plan');
  const db = createClient(local.API_URL, local.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const checked = <T extends { error: {message: string} | null }>(r: T): T => { if (r.error) throw Error(r.error.message); return r; };
  const accountId = randomUUID(); const workspaceId = randomUUID();
  checked(await db.from('accounts').insert({ id: accountId, name: 'Local release evaluation', slug: `release-eval-${accountId}` }));
  checked(await db.from('workspaces').insert({ id: workspaceId, account_id: accountId, name: domain, domain, status: 'setup', language, location_code: language === 'it' ? 2380 : 2840, ai_provider: 'claude', auto_generate_weekly_limit: 7 }));
  report.workspaceId = workspaceId; save();
  const inferred = await inferBusinessProfileDetailed(domain, {supabase: db, workspaceId});
  report.inference = inferred; save();
  const profile = inferred.profile;
  if (!profile?.primaryBuyer || !profile.priorityOffering) throw Error('Inferred focus needs a user decision; no silent substitute');
  checked(await db.from('workspaces').update({business_profile: profile}).eq('id', workspaceId));
  const workspace = checked(await db.from('workspaces').select('*').eq('id', workspaceId).single()).data!;
  const events: import('@/lib/onboarding/events').OnboardingEvent[] = [];
  console.log('START', domain, profile.primaryBuyer, profile.priorityOffering);
  const planned = await runOnboarding(db, workspace, event => { events.push(event); report.events = events; save(); if ('status' in event && event.status !== 'active') console.log('PHASE', domain, event.phase, event.status); }, {firstDraft: 'choose'});
  report.discoverySeconds = (Date.now() - Date.parse(String(report.startedAt))) / 1000;
  const choices = events.flatMap(event => 'planned' in event ? event.planned ?? [] : []);
  report.choices = choices;
  report.candidates = checked(await db.from('keywords').select('id,term,volume,difficulty,opportunity,research_evidence').eq('workspace_id', workspaceId)).data;
  save();
  if (!planned.awaitingChoice || !choices.length) throw Error('No supported choice; record failure without substituting a keyword');
  const selected = choices[0]; report.selected = selected;
  const start = Date.now();
  const preparation = await Promise.allSettled([
    readSiteText(domain).then(read => read.text.length >= 250 ? trainVoiceProfile(db, workspaceId, read.text) : undefined),
    detectLinks(db, workspaceId),
  ]);
  report.preparation = preparation.map(result => ({status:result.status})); save();
  const draft = await generateArticle({supabase: db, workspaceId, keyword:selected.term, keywordId:selected.keywordId, autonomous:true, verifySourceClaims:true, billToAccountId:accountId});
  const entry = checked(await db.from('calendar_entries').select('id').eq('workspace_id', workspaceId).eq('keyword_id', selected.keywordId).maybeSingle()).data;
  if (entry) await fulfilPlannedEntry(db, entry.id, draft.articleId);
  report.choiceToDraftSeconds = (Date.now() - start) / 1000;
  report.article = checked(await db.from('articles').select('*').eq('workspace_id', workspaceId).eq('id', draft.articleId).single()).data;
  report.spend = checked(await db.from('provider_spend').select('provider,operation,cost_usd').eq('workspace_id', workspaceId)).data;
  report.finishedAt = new Date().toISOString(); save();
  writeFileSync(`${out}/article.html`, draft.html, {mode:0o600});
  console.log('DONE', domain, draft.title, draft.wordCount, report.choiceToDraftSeconds);
}
main().catch(async error => {
  report.error = error instanceof Error ? error.message : String(error);
  report.finishedAt = new Date().toISOString();
  // Failed discovery still incurs provider spend; missing accounting is unknown.
  report.spend = null;
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (report.workspaceId && url && key && ['localhost', '127.0.0.1'].includes(new URL(url).hostname)) {
      const { createClient } = await import('@supabase/supabase-js');
      const { data, error: spendError } = await createClient(url, key, {auth:{persistSession:false}})
        .from('provider_spend').select('provider,operation,cost_usd').eq('workspace_id', report.workspaceId);
      if (!spendError) report.spend = data;
    }
  } catch { /* Preserve the original failure; unknown spend is not zero. */ }
  save(); console.error('FAILED', report.domain, report.error); process.exitCode = 1;
});
