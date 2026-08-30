# Agent-readiness checker

Answers one question per domain: **can an AI agent actually read this site?**

Stdlib Python, no dependencies. Writes to SQLite, exports CSV, and renders a
per-domain report in Italian ready to send.

```bash
cd tools/agent-readiness

python3 agent_readiness.py --domain example.com        # one site
python3 agent_readiness.py --limit 20                  # first 20 of the lead list
python3 agent_readiness.py                             # the whole verified shortlist
python3 agent_readiness.py --report example.com        # Italian report from stored results
python3 agent_readiness.py --summary                   # aggregate pass rates
python3 agent_readiness.py --csv out.csv --redact      # shareable export
```

There is also a TypeScript port used by the product and the CLI:

```bash
cd apps/web
npm run readiness -- example.com          # check + generate the missing artifacts
```

## Two tiers, and only one of them is scored

**Stable tier (scored).** robots.txt, AI-crawler directives, sitemap, structured
data, Organization schema, machine-readable content, title/meta, single h1,
content signals. Severity-weighted into a 0-100 score.

**Advanced tier (probed, never scored).** MCP server card, agent-skills index,
api-catalog, OAuth protected-resource, markdown negotiation.

They are kept apart on purpose. Checking for the advanced tier is one GET each;
*implementing adapters* for those draft protocols is a different and much larger
decision, and most of them will not survive. Folding them into the score would
also flatten it: 86% of sites score a flat zero there, so the number would stop
ranking outreach targets, which is its whole job.

**`AGENT_TIER` is the column that differentiates, not `SCORE`.**

## What the last full run found

274 agency sites analysed, 2026-08-16. Results in
`results/agency-agent-readiness-2026-08-16.csv`.

| | |
|---|---|
| Stable-tier mean | **83/100** |
| Advanced-tier probes passing | **3%** |
| Agencies at `AGENT_TIER 0/5` | **238 of 274 (86%)** |
| Agencies at `2/5` or better | **5** |

| Probe | Pass rate |
|---|---|
| `mcp_server_card` | 1% |
| `agent_skills` | 1% |
| `api_catalog` | 1% |
| `markdown_negotiation` | 5% |
| `oauth_resource` | 8% |

Read that as: these are SEO professionals, so the fundamentals are fine, and
essentially nobody has done the agent-era work. The stable-tier score is not the
story; the advanced tier is.

`TOP_GAP` names the most useful single thing to say to each agency, ordered by
conversational usefulness rather than raw severity. Across the run: 95 have no
machine-readable version, 35 are not resolvable entities, 14 block AI crawlers
outright.

## Sampling caveat, which matters if you publish any of this

This cohort was sourced by looking for agencies that market GEO. It is not a
random sample of agencies, so it **cannot** sit in an adoption denominator
without saying so. The Italian and international sub-cohorts also diverge
sharply (8% vs 29% selling GEO), so treat any blended figure as a range.

## Data handling

The lead CSVs and the SQLite database live in `hanoi/leadgen/`, which is
**gitignored**, because they contain scraped business contact data for real
named people. This directory holds **code only**.

`--redact` drops `CONTACT` and `EMAIL`. Use it for anything committed, shared or
attached. The findings are all derived from public site configuration and are
safe to share; the contact columns are not.

On 2026-08-15 those CSVs were found on four branches of a public repo. Do not
recreate that. See `memory/open-loops.md`.

## Politeness

Identifies itself honestly in the User-Agent, rate-limits per host, caps at six
workers, and reads nothing but public site configuration: `robots.txt`,
`sitemap.xml`, `llms.txt`, `.well-known/*`, and the homepage.

The UA is browser-shaped (`Mozilla/5.0 (compatible; AltoRank-AgentReadiness/1.0;
+https://altorank.co)`) because a bare tool UA gets WAF-challenged or served a
stripped page, which produced false "no structured data" findings on sites that
plainly had it. The real identity stays in the string so the check remains
declarable if anyone asks.

## Bugs already found and fixed, so they are not re-introduced

Every one of these was found by running against live sites, not by unit tests,
and each has a regression test:

1. **JSON-LD `@type` must be collected recursively.** Yoast and most WordPress
   schema plugins emit `{"@context":..., "@graph":[...]}`. Reading only
   top-level `@type` reported 32% schema adoption where the truth was 94%.
2. **A bare tool User-Agent gets blocked.** See above.
3. **`5xx` on `/robots.txt` is "refused", not "absent".** Reporting the latter is
   a false claim about someone's site.
4. **`llms.txt` needs its content checked, not just its status.** A site that
   301s `/llms.txt` to its homepage returns `200 text/html` and passed.
   Confirmed on `cloudflare.com`.
5. **Company names must not come from `<title>`.** Agency titles lead with
   keyword phrases, so the heuristic proposed `genesi.it` is called
   "Realizzazione siti web". Source order is now `og:site_name` → footer
   copyright line → title segment matching the domain.
6. **Logo `alt` is not a name source.** `datodigitale.it`'s logo alt is "Enel", a
   *client's* brand.

## Not implemented, deliberately

Client-domain discovery. Agency sites average 83/100, so the sharper findings
almost certainly live on their **clients'** sites. Scraping portfolio pages for
outbound client links is the obvious next increment and is not built.
