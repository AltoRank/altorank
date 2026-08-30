# AltoRank

**An AI SEO content engine that never publishes without you.**

It researches a keyword, writes the article, scores it, checks its claims, and
publishes it to your CMS. A person approves every article before it goes live.
That last part is not a setting you can switch off.

Open source, the whole product. No feature-gated tier, no `ee/` directory.

---

## Status: pre-launch

Read this before you invest time in it.

- **No paying customers, no case studies.** Nothing here has a growth figure
  attached to it, and that is on purpose.
- **There is no CLI yet.** The MCP server exists (`npm run mcp`); a packaged
  command-line tool does not.
- **The hosted dashboard is what runs today.** It works locally against your own
  Supabase and your own API keys.

If you want a finished product, wait. If you want to read how it works or run it
yourself, everything is here.

## The approval gate

This is the one design decision the rest of the product is built around, so it
is worth stating as a mechanism rather than a promise:

- The **MCP server exposes no publish tool.** Not a disabled tool, an absent
  one. See the comment at the top of `apps/web/scripts/mcp.ts`.
- **`auto_generate` has no publish counterpart.** Generation can be automated.
  Publishing cannot.
- Publishing defaults to draft status, and the gate lives in the publish step
  itself, so scheduled jobs and bulk actions cannot route around it.

Competing tools ship the words "you stay in control" as copy. The difference is
checkable here: grep for a publish tool and you will not find one.

## What works today

| | |
|---|---|
| Keyword research + SERP analysis | DataForSEO |
| Domain audit | 9 readiness checks, crawl, PageSpeed |
| Article generation | research → draft → score → fact-check |
| Brand voice | per-workspace voice profiles |
| Publishing | **12 destinations** (below) |
| Locales | **35** (`apps/web/lib/seo/locales.ts`) |
| Rank tracking | scheduled SERP checks |
| AI visibility | whether AI answers name you, and who they name instead |

**Publishing destinations** (`apps/web/lib/cms/adapter.ts`): Framer, Ghost, git,
HubSpot, Magento, Notion, Shopify, Webflow, webhook, Wix, WooCommerce,
WordPress.

## Running it

Requires Node 20+, and a Supabase project (local via Docker, or hosted).

```bash
npm install
cp apps/web/.env.local.example apps/web/.env.local
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

### Database

`apps/web/supabase/` carries a `config.toml` and 21 migrations that apply in
order. With the [Supabase CLI](https://supabase.com/docs/guides/cli):

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
apps/web/
  app/(dashboard)/      dashboard routes
  lib/audit/            domain analysis, readiness checks
  lib/seo/              recommendations, scoring, locales, topical profile
  lib/content/          generation (one implementation, shared by route + cron)
  lib/ai/               fact checking
  lib/cms/              12 publishing adapters
  lib/geo/              AI-answer visibility
  scripts/mcp.ts        MCP server
tools/agent-readiness/  standalone agent-readiness scanner
```

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

- Adding a way to publish without human approval.
- Adding a claim the repository cannot support. If `grep` cannot find the
  feature, the README does not get to mention it.
