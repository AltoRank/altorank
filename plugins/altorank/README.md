# AltoRank plugin

Connects Claude (and other agent hosts that read this format) to
[AltoRank](https://altorank.co), the open-source SEO and AI-search content
tool. Ask in plain language to check whether AI assistants can read a site,
get the JSON-LD a page is missing, read your Search Console numbers, research
keywords, move your content calendar, or write an SEO draft.

Drafts go to a review queue in AltoRank. A person approves and publishes them.
The plugin has no publish, approve or delete tool, and the API behind it has
no endpoint for one.

## What it contains

- **MCP server** `altorank`: AltoRank's hosted server at
  `https://app.altorank.co/api/mcp` (Streamable HTTP), 26 tools.
- **Skill** `altorank`: how to use those tools safely (preflight, drafting,
  propose-before-write, reading Search Console states).

Nothing runs on your machine. There are no hooks, scripts or local commands.

## Install

Claude Code. From a terminal:

```bash
claude plugin marketplace add AltoRank/altorank
claude plugin install altorank@altorank
```

Or inside a Claude Code session: `/plugin marketplace add AltoRank/altorank`,
then `/plugin install altorank@altorank`.

Connecting opens AltoRank's OAuth consent page; a free AltoRank account is enough. Read-only
access is the default; tick write access there if you want Claude to edit
drafts or move the plan. Revoke it any time under Settings → API keys.

The four readiness tools work on any public domain, not only sites in your workspaces.

## Data it sends

Tool calls, with the arguments Claude passes (domains, keywords, workspace and
article ids, find-and-replace text), go to `app.altorank.co` over HTTPS, and
only there. Results come back from the same server. Self-hosted AltoRank
installs can point a custom connector at their own origin instead.

- Privacy policy: https://altorank.co/privacy/
- Terms: https://altorank.co/terms/
- Docs: https://altorank.co/docs/mcp/
- Support: hello@altorank.co

## License

AGPL-3.0-only, same as the rest of the [AltoRank repository](https://github.com/AltoRank/altorank).
