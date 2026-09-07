# AltoRank

**An AI SEO content engine where every publish is somebody's decision.**

It researches a keyword, writes the article, scores it, checks its claims, and
publishes it to your CMS. Who decides that it ships is yours to choose per
workspace: approve each draft by hand, or set a rule that publishes after a hold
unless you hold it. Either way the approval is recorded under a named person,
and the article is tracked after - indexing, rank, AI-search visibility.

Open source, the whole product. No feature-gated tier, no `ee/` directory.

---

## Status: pre-launch

Read this before you invest time in it.

- **No paying customers, no case studies.** Nothing here has a growth figure
  attached to it, and that is on purpose.
- **The CLI is not packaged.** `npm run cli` from `apps/web` drives the whole
  agent API (`apps/web/scripts/cli.ts`), and `apps/web/scripts/SKILL.md` is the
  skill file a coding agent reads. There is no published npm binary yet, so
  today it runs from a checkout rather than from `npx`.
- **The hosted dashboard is what runs today.** It works locally against your own
  Supabase and your own API keys.

If you want a finished product, wait. If you want to read how it works or run it
yourself, everything is here.

## The publishing decision

One gate, two ways through it. `lib/publishing/core.ts` refuses any article
that is not `approved` (or `scheduled` with `approved_by` set), and nothing else
in the code path writes `live`. What can write an approval:

- **A person**, from the editor (`approveArticle`), recorded as `approved_by`.
- **A rule the workspace owner set** (`auto_approve`, migration 079): the
  publish cron runs the same checks the Approve button runs - active plan, no
  unsourced figure, no failing audit item, SEO score at or above the floor -
  after a hold window (default 24h) during which the drafted email carries a
  one-click Hold. `approved_by` is whoever turned the rule on; `approval_kind`
  says `auto`. Held drafts carry the reason on their own row. See
  `lib/publishing/auto-approve.ts`.

What cannot write an approval: an agent. The **MCP server and the agent API
expose no publish or approve tool** - not disabled, absent. See the comment at
the top of `apps/web/scripts/mcp.ts`.

Competing tools ship the words "you stay in control" as copy. The difference
is checkable here: every `live` row points at a person, by click or by rule.

## What works today

| | |
|---|---|
| Keyword research + SERP analysis | DataForSEO |
| Domain audit | 9 readiness checks, crawl, PageSpeed |
| Article generation | research → draft → score → fact-check |
| Brand voice | per-workspace voice profiles |
| Publishing | **13 destinations** (below) |
| Locales | **35** (`apps/web/lib/seo/locales.ts`) |
| Rank tracking | scheduled SERP checks |
| Search analytics | Google Search Console; Bing Webmaster Tools (clicks and impressions per day) |
| AI visibility | whether AI answers name you, and who they name instead |

**Publishing destinations** (`apps/web/lib/cms/adapter.ts`) — thirteen adapters
covering **ten CMS platforms**; WordPress is reachable two ways, and `git` and
`webhook` are publishing targets rather than CMSs. Framer, Ghost, git, HubSpot, Magento,
Notion, Shopify, Webflow, webhook, Wix, WooCommerce, WordPress, and the
WordPress plugin — a second, recommended route to WordPress that installs a
plugin and takes a per-site token instead of an application password
(`apps/web/lib/cms/wordpress-plugin.ts`), which is why WordPress appears twice.

## Running it

Requires Node 22+, and a Supabase project (local via Docker, or hosted).
The full deployment story, hosted and self-hosted, is in
[docs/deploy.md](docs/deploy.md); the Cloudflare assessment is in
[docs/deploy-cloudflare.md](docs/deploy-cloudflare.md).

```bash
npm install
cp docker/.env.example apps/web/.env.local   # every variable, with what each one enables
npm run dev
```

Four things are genuinely required before it will run: your Supabase URL and
its two keys, an `ANTHROPIC_API_KEY`, and an `ENCRYPTION_KEY`
(`openssl rand -hex 32`). Add `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` for
keyword volume and rank tracking; without them those steps skip rather than
fail. Everything else in the example file is optional and each one disables
exactly one feature. The file says which.

Other entry points:

```bash
npm run mcp      # MCP server, for driving the engine from an AI assistant
npm run test     # vitest
npm run smoke    # research → prompt → model → fact check, against real APIs
```

and from `apps/web`:

```bash
npm run cli -- --help        # the agent API from a shell; auth with ALTORANK_API_KEY
npm run readiness -- <domain>  # the agent-readiness checks on their own
```

Neither the CLI nor the MCP server can approve an article or delete anything —
not by configuration, but because the agent API has no such call and no `DELETE`
handler at all. Nor can either of them publish: the single endpoint that reaches
a CMS is `POST /articles/{id}/retry-publish`, which re-runs a publish that
**a human already approved** and that then failed. An article in draft or review
is refused, and the refusal tells the caller to hand it to a person
(`apps/web/app/api/agent/v1/articles/[id]/retry-publish/route.ts:13-35`).

### Database

`apps/web/supabase/` carries a `config.toml` and the numbered migrations, which
apply in order. With the [Supabase CLI](https://supabase.com/docs/guides/cli):

```bash
cd apps/web
supabase start      # local Postgres + auth, prints the URL and keys for .env.local
supabase db push    # applies the migrations
```

Against a hosted project, `supabase link --project-ref <ref>` first, then
`supabase db push`. The app will not get far without the migrations: every
query targets tables they create.

`docker/` has a container setup if you would rather not run Node directly.

## Layout

```
apps/web/               the engine and dashboard (Next.js)
  app/(dashboard)/      dashboard routes
  lib/audit/            domain analysis, readiness checks
  lib/seo/              recommendations, scoring, locales, topical profile
  lib/content/          generation (one implementation, shared by route + cron)
  lib/ai/               fact checking
  lib/cms/              13 publishing adapters
  lib/geo/              AI-answer visibility
  scripts/mcp.ts        MCP server
  scripts/cli.ts        CLI over /api/agent/v1
  scripts/SKILL.md      the skill file a coding agent reads
docker/                 container setup for self-hosting
tools/agent-readiness/  standalone agent-readiness scanner
```

The marketing site (altorank.co) lives in its own private repository,
`AltoRank/altorank-marketing`. It moved out of this tree on 2026-09-06 so the
product stays open while positioning and pricing copy do not. Nothing here
imports it; the two are coupled only by the plan limits noted in
`apps/web/lib/stripe.ts` and `apps/web/lib/billing/quota.ts`, which must be
changed in both places together.

Two conventions worth knowing before you send a patch:

1. **Never render an unknown as zero.** A number nobody measured, displayed as a
   measurement, is a fabricated claim even when no human typed it. Use
   `number | null`, render an em dash, and average only over rows that have a
   value.
2. **One implementation per behaviour.** Generation lives in
   `lib/content/generate.ts`; the streaming route and the cron both call it.
   Resist the second copy.

## Licence

**GNU AGPL-3.0-only.** Full text in [LICENSE](LICENSE).

In practice: self-host it, run it for your own clients, commercially, and you
owe nothing and publish nothing. The one obligation only reaches people
rebuilding the product. If you modify the source and offer that modified version
to others over a network, your changes have to be shared back under the same
licence.

Running an agency on it is free and unencumbered. Relaunching a modified copy as
a closed competing service is not.

## Contributing

Issues and pull requests are welcome. Two things that will get a patch rejected
regardless of how good the code is:

- Adding a way to publish that is not attributable to a person - a click, or a
  rule a named member set and can veto. An agent-triggered publish is the
  canonical example.
- Adding a claim the repository cannot support. If `grep` cannot find the
  feature, the README does not get to mention it.
