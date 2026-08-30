# Security

## Reporting a vulnerability

Email **hello@altorank.co** with "security" in the subject. Please do not open
a public issue for anything exploitable.

Include what you need to make the problem reproducible: affected version or
commit, the steps, and what an attacker gets out of it. If you have a proof of
concept, send it privately rather than publishing it.

You will get an acknowledgement. AltoRank is pre-launch and maintained by a very
small team, so expect a human reply in days rather than hours, and no bounty
programme.

## Scope

This repository is the self-hostable engine. If you are running it yourself, you
own the deployment: your Supabase project, your API keys, your infrastructure.
Reports about a self-hosted instance's own misconfiguration are not
vulnerabilities in this project, though we would still like to hear about
anything the defaults get wrong.

## Things worth knowing before you report

- **`SUPABASE_SERVICE_ROLE_KEY` bypasses row-level security** and is server-only
  by design. It must never be given a `NEXT_PUBLIC_` prefix. If you find a code
  path that leaks it to the browser, that is a real finding.
- **`ENCRYPTION_KEY` encrypts stored CMS credentials** with AES-256-GCM
  (`apps/web/lib/crypto.ts`). Rotating it makes existing stored credentials
  undecryptable; that is expected, not a bug.
- **`/api/cron/*` is gated on a shared secret** in the `x-cron-secret` header.
  With `CRON_SECRET` unset every cron endpoint returns 401, which is the safe
  default. A route reachable without that header would be a finding.
- **The approval gate is a security property, not just a product one.** Nothing
  publishes without a human: the MCP server exposes no publish tool and
  `auto_generate` has no publish counterpart. Any path that publishes to a
  connected CMS without human approval is a vulnerability, and we want to hear
  about it.

## What we will not treat as a finding

- Missing rate limits on a self-hosted instance you control
- Vulnerabilities in a dependency with no demonstrated path through this code
- Automated scanner output with no working proof of concept
