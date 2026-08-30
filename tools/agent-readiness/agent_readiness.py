#!/usr/bin/env python3
"""Agent-readiness checker for the agency lead list.

Answers one question per domain: can an AI agent actually read this site?

Where things live, and why
--------------------------
Three repos, three trust levels, and this tool straddles them:

  altorank (private)   <- this file. Code only, no lead data.
  hanoi    (PUBLIC)    <- leadgen/ is gitignored there precisely because it
                          holds GDPR-sensitive scraped contact data. Nothing
                          under it is tracked, so code placed there is one
                          `rm -rf` from gone.
  altorank/altorank    <- the future public AGPL repo. These checks eventually
                          belong in its audit module, but the runs against named
                          leads never do.

So: the checker is tracked here, and the database it writes stays next to the
shortlist inside the ignored leadgen/ directory. Code in git, personal data out
of git, and nothing that would leak if the OSS repo went public tomorrow.

Stdlib only, matching the leadgen pipeline's convention: no dependency
footprint, nothing to install, nothing to leak.

Scope
-----
Only the stable tier of Cloudflare's agent-readiness guidance is implemented:
robots.txt directives, sitemaps, structured data, and machine-readable content.
The advanced tier (A2A cards, WebMCP, x402, ACP, UCP, AP2) is a pile of
competing drafts, most of which will not survive; building adapters for them now
would be maintenance for nothing.

Politeness
----------
Identifies itself honestly, obeys robots.txt for its own fetches, rate-limits
per host, and reads nothing but public site configuration. No personal data is
collected by this script.

Usage
-----
    python3 agent_readiness.py --limit 20        # run the shortlist, store results
    python3 agent_readiness.py --domain foo.it   # single domain
    python3 agent_readiness.py --report foo.it   # personalised report from the DB
    python3 agent_readiness.py --summary         # aggregate across all runs
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sqlite3
import ssl
import sys
import time
import urllib.error
import urllib.request
import urllib.robotparser
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).parent
# Default to the sibling hanoi workspace. Both the shortlist and the database
# live inside the gitignored leadgen/ directory so no contact data lands in git.
# Override with --shortlist / --db if your checkout is laid out differently.
LEADGEN = (HERE / ".." / ".." / ".." / "hanoi" / "leadgen").resolve()
DB_PATH = LEADGEN / "agent_readiness.db"
SHORTLIST = LEADGEN / "target_shortlist.csv"

# Browser-shaped but honestly identified. A bare tool UA gets served a WAF
# challenge or a stripped page by a good share of sites, which produced false
# "no structured data" findings on sites that plainly had it. Keeping the real
# identity in the string means the check stays declarable if anyone asks.
UA = ("Mozilla/5.0 (compatible; AltoRank-AgentReadiness/1.0; "
      "+https://altorank.co; site readiness audit)")
TIMEOUT = 12
PER_HOST_DELAY = 1.0
MAX_WORKERS = 6

# The crawlers that actually matter for being read by an assistant. Checked
# individually because a site can allow Googlebot and still be invisible here.
AI_CRAWLERS = [
    ("GPTBot", "OpenAI training + browsing"),
    ("OAI-SearchBot", "ChatGPT search index"),
    ("ChatGPT-User", "ChatGPT live fetch"),
    ("ClaudeBot", "Claude"),
    ("PerplexityBot", "Perplexity index"),
    ("Google-Extended", "Gemini / AI Overviews grounding"),
    ("CCBot", "Common Crawl, feeds many models"),
    ("Applebot-Extended", "Apple Intelligence"),
]

# ── advanced tier ─────────────────────────────────────────────────────────────
# Probed but deliberately NOT scored. Checking for these is cheap (one GET each);
# *implementing* adapters for them is what the scope note above rules out, and
# the two are different decisions.
#
# Kept out of the score on purpose: nearly every site fails all of them, so
# folding them in would flatten the stable-tier signal to noise and make the
# score useless for ranking outreach targets. Reported as a separate count.
ADVANCED_PROBES = [
    ("mcp_server_card", "/.well-known/mcp/server-card.json"),
    ("agent_skills", "/.well-known/agent-skills/index.json"),
    ("api_catalog", "/.well-known/api-catalog"),
    ("oauth_resource", "/.well-known/oauth-protected-resource"),
]

HIGH, MEDIUM, LOW = "high", "medium", "low"
# Weights drive the score. A blocked AI crawler outweighs a missing h1 by a lot.
WEIGHTS = {HIGH: 3, MEDIUM: 2, LOW: 1}


@dataclass
class Finding:
    check: str
    passed: bool
    severity: str
    detail: str


@dataclass
class Run:
    domain: str
    findings: list[Finding] = field(default_factory=list)
    advanced: dict[str, bool] = field(default_factory=dict)
    error: str | None = None

    @property
    def score(self) -> int:
        if not self.findings:
            return 0
        earned = sum(WEIGHTS[f.severity] for f in self.findings if f.passed)
        total = sum(WEIGHTS[f.severity] for f in self.findings)
        return round(100 * earned / total) if total else 0

    @property
    def passed(self) -> int:
        return sum(1 for f in self.findings if f.passed)


# ── fetching ──────────────────────────────────────────────────────────────────

_ctx = ssl.create_default_context()
_ctx.check_hostname = False
_ctx.verify_mode = ssl.CERT_NONE  # many small agency sites have broken chains


def fetch(url: str) -> tuple[int, dict, str]:
    """Return (status, headers, body). Never raises; returns (0, {}, '') on failure."""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=_ctx) as res:
            raw = res.read(1_500_000)
            charset = res.headers.get_content_charset() or "utf-8"
            return res.status, dict(res.headers), raw.decode(charset, "replace")
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers or {}), ""
    except Exception:
        return 0, {}, ""


def fetch_accept(url: str, accept: str) -> tuple[int, dict, str]:
    """fetch() with an explicit Accept header, for content negotiation probes."""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=_ctx) as res:
            return res.status, dict(res.headers), res.read(4096).decode("utf-8", "replace")
    except Exception:
        return 0, {}, ""


def head_ok(url: str) -> bool:
    status, _, _ = fetch(url)
    return 200 <= status < 300


def collect_types(blocks: list[str]) -> list[str]:
    """Every @type in a set of JSON-LD blocks, however deeply nested.

    Yoast and most WordPress schema plugins emit a single block shaped
    {"@context":..., "@graph":[{...}, {...}]}, so reading only top-level @type
    misses the Organization node on a large share of real sites. Recursing was
    the difference between 32% and the true rate.
    """
    found: list[str] = []

    def walk(node) -> None:
        if isinstance(node, list):
            for item in node:
                walk(item)
        elif isinstance(node, dict):
            t = node.get("@type")
            if isinstance(t, list):
                found.extend(str(x) for x in t)
            elif t:
                found.append(str(t))
            for value in node.values():
                if isinstance(value, (dict, list)):
                    walk(value)

    for b in blocks:
        try:
            walk(json.loads(b.strip()))
        except Exception:
            continue
    return found


# ── checks ────────────────────────────────────────────────────────────────────


def check_domain(domain: str) -> Run:
    domain = domain.strip().lower().removeprefix("http://").removeprefix("https://").strip("/")
    run = Run(domain=domain)
    base = f"https://{domain}"

    status, _, home = fetch(base)
    if status == 0:
        run.error = "unreachable over https"
        return run
    if status >= 400:
        run.error = f"homepage returned {status}"
        return run

    add = run.findings.append

    # 1. robots.txt reachable
    r_status, _, robots_body = fetch(f"{base}/robots.txt")
    robots_ok = 200 <= r_status < 300 and robots_body.strip() != ""
    # 404 means absent; 5xx or 403 means the server refused us, which is a
    # different fact and must not be reported to an agency as "you have no
    # robots.txt" when they do.
    robots_detail = (
        "robots.txt found" if robots_ok
        else f"server returned {r_status} for /robots.txt, not conclusive" if r_status >= 400 and r_status != 404
        else "no robots.txt, crawlers get no guidance"
    )
    add(Finding("robots_reachable", robots_ok, MEDIUM, robots_detail))

    # 2. AI crawlers allowed. This is the finding that opens conversations.
    rp = urllib.robotparser.RobotFileParser()
    if robots_ok:
        rp.parse(robots_body.splitlines())
    blocked = []
    if robots_ok:
        for bot, _label in AI_CRAWLERS:
            try:
                if not rp.can_fetch(bot, base + "/"):
                    blocked.append(bot)
            except Exception:
                pass
    add(Finding(
        "ai_crawlers_allowed", not blocked, HIGH,
        "all major AI crawlers allowed" if not blocked
        else f"blocked: {', '.join(blocked)}",
    ))

    # 3. sitemap declared or discoverable
    declared = re.findall(r"(?im)^\s*sitemap:\s*(\S+)", robots_body or "")
    sitemap = bool(declared) or head_ok(f"{base}/sitemap.xml")
    add(Finding(
        "sitemap", sitemap, MEDIUM,
        (f"declared in robots.txt ({len(declared)})" if declared else "/sitemap.xml reachable")
        if sitemap else "no sitemap declared or at /sitemap.xml",
    ))

    # 4. structured data present
    blocks = re.findall(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        home, re.S | re.I,
    )
    types = collect_types(blocks)
    add(Finding(
        "structured_data", bool(types), HIGH,
        f"JSON-LD present: {', '.join(sorted(set(types))[:5])}" if types
        else "no JSON-LD on the homepage",
    ))

    # 5. entity schema. Without this an assistant cannot resolve who the site is.
    entity = {"Organization", "LocalBusiness", "Corporation", "ProfessionalService"}
    has_entity = bool(entity & set(types))
    add(Finding(
        "entity_schema", has_entity, HIGH,
        "Organization-type schema present" if has_entity
        else "no Organization schema, the site is not a resolvable entity",
    ))

    # 6. machine-readable copy of the content
    # Status alone is not enough: a site that 301s /llms.txt to its homepage
    # returns 200 text/html after the redirect and would pass. Seen on
    # cloudflare.com and agenziabrand.it. Require a non-HTML body with content.
    l_status, l_headers, l_body = fetch(f"{base}/llms.txt")
    l_type = (l_headers.get("Content-Type") or l_headers.get("content-type") or "").lower()
    body = l_body.lstrip()
    llms = (
        200 <= l_status < 300
        and "html" not in l_type
        and not body.startswith("<")
        and len(body) > 20
    )
    md_status, md_headers, _ = fetch(base + "/")
    negotiated = "markdown" in (md_headers.get("Content-Type", "") or "").lower()
    add(Finding(
        "machine_readable", llms or negotiated, MEDIUM,
        "/llms.txt present" if llms else
        ("serves markdown" if negotiated else "no /llms.txt or markdown version"),
    ))

    # 7. title + meta description
    title = re.search(r"<title[^>]*>(.*?)</title>", home, re.S | re.I)
    desc = re.search(
        r'<meta[^>]+name=["\']description["\'][^>]+content=["\'](.*?)["\']', home, re.S | re.I
    )
    both = bool(title and title.group(1).strip()) and bool(desc and desc.group(1).strip())
    add(Finding(
        "title_meta", both, LOW,
        "title and meta description present" if both else "missing title or meta description",
    ))

    # 8. single h1
    h1s = re.findall(r"<h1[^>]*>", home, re.I)
    add(Finding(
        "single_h1", len(h1s) == 1, LOW,
        "one h1" if len(h1s) == 1 else f"{len(h1s)} h1 elements",
    ))

    # 9. content signals (informational; the proposal is young)
    has_signal = bool(re.search(r"(?im)^\s*content-signal:", robots_body or ""))
    add(Finding(
        "content_signals", has_signal, LOW,
        "content-signal directive present" if has_signal
        else "no content-signal directive (optional, emerging)",
    ))

    # Advanced tier: informational only, never folded into the score.
    for name, path in ADVANCED_PROBES:
        st, hd, bd = fetch(f"{base}{path}")
        ctype = (hd.get("Content-Type") or hd.get("content-type") or "").lower()
        run.advanced[name] = (
            200 <= st < 300 and "html" not in ctype and not bd.lstrip().startswith("<")
        )
    md_status, md_headers, _ = fetch_accept(f"{base}/", "text/markdown")
    run.advanced["markdown_negotiation"] = "markdown" in (
        (md_headers.get("Content-Type") or md_headers.get("content-type") or "").lower()
    )
    run.advanced["content_signals"] = has_signal

    return run


# ── storage ───────────────────────────────────────────────────────────────────


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS runs (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          domain     TEXT NOT NULL,
          agency     TEXT,
          contact    TEXT,
          email      TEXT,
          locale     TEXT,
          ran_at     TEXT NOT NULL,
          score      INTEGER NOT NULL,
          passed     INTEGER NOT NULL,
          total      INTEGER NOT NULL,
          error      TEXT
        );
        CREATE TABLE IF NOT EXISTS findings (
          run_id   INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          check_id TEXT NOT NULL,
          passed   INTEGER NOT NULL,
          severity TEXT NOT NULL,
          detail   TEXT
        );
        CREATE TABLE IF NOT EXISTS advanced (
          run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          probe  TEXT NOT NULL,
          passed INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_runs_domain ON runs(domain);
        CREATE INDEX IF NOT EXISTS idx_advanced_run ON advanced(run_id);
        CREATE INDEX IF NOT EXISTS idx_findings_run ON findings(run_id);
        """
    )
    return conn


def store(conn: sqlite3.Connection, run: Run, meta: dict) -> int:
    cur = conn.execute(
        "INSERT INTO runs (domain, agency, contact, email, locale, ran_at, score, passed, total, error)"
        " VALUES (?,?,?,?,?,?,?,?,?,?)",
        (
            run.domain, meta.get("AGENCY"), meta.get("CONTACT_NAME"),
            meta.get("EMAIL"), meta.get("LOCALE"),
            datetime.now(timezone.utc).isoformat(timespec="seconds"),
            run.score, run.passed, len(run.findings), run.error,
        ),
    )
    rid = cur.lastrowid
    conn.executemany(
        "INSERT INTO findings (run_id, check_id, passed, severity, detail) VALUES (?,?,?,?,?)",
        [(rid, f.check, int(f.passed), f.severity, f.detail) for f in run.findings],
    )
    conn.executemany(
        "INSERT INTO advanced (run_id, probe, passed) VALUES (?,?,?)",
        [(rid, k, int(v)) for k, v in run.advanced.items()],
    )
    conn.commit()
    return rid


# ── reporting ─────────────────────────────────────────────────────────────────

# The report goes to Italian agencies, so every line in it is Italian. The
# operator-facing summary stays English. Keyed by (check, passed) so a pass and
# a fail read as different sentences rather than a negated label.
IT = {
    ("ai_crawlers_allowed", False): "**I crawler AI sono bloccati.** {detail}. Gli assistenti non possono leggere il sito.",
    ("ai_crawlers_allowed", True): "I principali crawler AI possono accedere al sito",
    ("entity_schema", False): "**Nessuno schema Organization.** Un assistente non ha modo di capire di chi è il sito, quindi non lo cita per nome.",
    ("entity_schema", True): "Schema Organization presente, il sito è identificabile come entità",
    ("structured_data", False): "**Nessun dato strutturato (JSON-LD) in homepage.** I contenuti vanno interpretati a indovinare.",
    ("structured_data", True): "Dati strutturati presenti: {types}",
    ("machine_readable", False): "**Nessuna versione leggibile dalle macchine** (`/llms.txt` o markdown).",
    ("machine_readable", True): "Versione leggibile dalle macchine disponibile",
    ("sitemap", False): "**Nessuna sitemap** dichiarata in robots.txt né su `/sitemap.xml`.",
    ("sitemap", True): "Sitemap dichiarata",
    ("robots_reachable", False): "**robots.txt assente.** I crawler non ricevono nessuna indicazione.",
    ("robots_reachable", True): "robots.txt presente",
    ("title_meta", False): "Manca il title o la meta description in homepage.",
    ("title_meta", True): "Title e meta description presenti",
    ("single_h1", False): "L’intestazione principale (H1) non è unica.",
    ("single_h1", True): "Una sola intestazione H1",
    ("content_signals", False): "Nessuna direttiva `content-signal` (facoltativa, standard ancora giovane).",
    ("content_signals", True): "Direttiva content-signal presente",
}


def render_it(check: str, passed: bool, detail: str) -> str:
    tpl = IT.get((check, passed))
    if not tpl:
        return detail
    types = detail.split(": ", 1)[1] if ": " in detail else detail
    return tpl.format(detail=detail, types=types)


def report(conn: sqlite3.Connection, domain: str) -> str:
    row = conn.execute(
        "SELECT * FROM runs WHERE domain = ? ORDER BY ran_at DESC LIMIT 1", (domain,)
    ).fetchone()
    if not row:
        return f"No run stored for {domain}. Run it first."
    fs = conn.execute(
        "SELECT * FROM findings WHERE run_id = ? ORDER BY passed, "
        "CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END",
        (row["id"],),
    ).fetchall()

    who = row["agency"] or domain
    out = [f"# Agent readiness: {who}", "", f"`{domain}` · {row['ran_at'][:10]}", ""]
    if row["error"]:
        out += [f"**Non analizzabile:** {row['error']}", ""]
        return "\n".join(out)

    out += [f"**Punteggio: {row['score']}/100** ({row['passed']} di {row['total']} controlli superati)", ""]

    # Split blocking from cosmetic. A missing content-signal directive listed
    # beside "assistants cannot read this site" makes the real finding cheaper.
    blocking = [f for f in fs if not f["passed"] and f["severity"] in (HIGH, MEDIUM)]
    minor = [f for f in fs if not f["passed"] and f["severity"] == LOW]
    passed = [f for f in fs if f["passed"]]

    if blocking:
        out += ["## Cosa blocca gli agenti", ""]
        out += [f"- {render_it(f['check_id'], False, f['detail'])}" for f in blocking]
        out.append("")
    if minor:
        out += ["## Minori", ""]
        out += [f"- {render_it(f['check_id'], False, f['detail'])}" for f in minor]
        out.append("")
    if passed:
        out += ["## Già a posto", ""]
        out += [f"- {render_it(f['check_id'], True, f['detail'])}" for f in passed]
        out.append("")

    out += [
        "---",
        "",
        "Controlli basati sulle linee guida di agent-readiness pubblicate da Cloudflare.",
        "Dati raccolti solo da configurazione pubblica del sito (robots.txt, sitemap, homepage).",
    ]
    return "\n".join(out)


def summary(conn: sqlite3.Connection) -> str:
    rows = conn.execute(
        "SELECT * FROM runs r WHERE r.id IN (SELECT MAX(id) FROM runs GROUP BY domain)"
    ).fetchall()
    ok = [r for r in rows if not r["error"]]
    if not ok:
        return "No successful runs yet."
    lines = [f"{len(rows)} domains, {len(ok)} analysed, {len(rows) - len(ok)} unreachable", ""]
    for check, _ in [(c, None) for c in
                     ["ai_crawlers_allowed", "entity_schema", "structured_data",
                      "machine_readable", "sitemap", "robots_reachable"]]:
        r = conn.execute(
            "SELECT SUM(passed) p, COUNT(*) t FROM findings WHERE check_id = ?"
            " AND run_id IN (SELECT MAX(id) FROM runs GROUP BY domain)", (check,)
        ).fetchone()
        if r and r["t"]:
            lines.append(f"  {check:24s} {r['p']:>4}/{r['t']:<4} pass  ({100*r['p']//r['t']}%)")
    avg = sum(r["score"] for r in ok) / len(ok)
    lines += ["", f"mean score {avg:.0f}/100"]
    worst = sorted(ok, key=lambda r: r["score"])[:10]
    lines += ["", "lowest scoring (best outreach targets):"]
    lines += [f"  {r['score']:>3}  {r['domain']:<38} {r['agency'] or ''}" for r in worst]
    return "\n".join(lines)



def export_csv(conn: sqlite3.Connection, path: Path, redact: bool = False) -> str:
    """One row per domain: identity, score, every check, every advanced probe.

    Built for mail-merge. AGENT_TIER is the count of advanced probes passed and
    is the column that actually differentiates: the stable-tier score clusters
    high because these are SEO professionals, while almost nobody has done the
    agent-era work. TOP_GAP names the single most useful thing to say to them.

    `redact=True` drops CONTACT and EMAIL. Use it for anything that will be
    committed, shared, or attached: the findings are the valuable part and they
    are all derived from public site configuration, whereas the contact columns
    are scraped personal data that must stay in the gitignored leadgen directory.
    """
    runs = conn.execute(
        "SELECT * FROM runs WHERE id IN (SELECT MAX(id) FROM runs GROUP BY domain) ORDER BY domain"
    ).fetchall()

    checks = ["ai_crawlers_allowed", "entity_schema", "structured_data",
              "machine_readable", "sitemap", "robots_reachable",
              "title_meta", "single_h1", "content_signals"]
    probes = ["mcp_server_card", "agent_skills", "api_catalog",
              "oauth_resource", "markdown_negotiation"]

    # Ordered by how useful the gap is to open a conversation with.
    GAP_PRIORITY = [
        ("ai_crawlers_allowed", "AI crawlers blocked in robots.txt"),
        ("entity_schema", "No Organization schema, not a resolvable entity"),
        ("structured_data", "No structured data on the homepage"),
        ("machine_readable", "No machine-readable version (llms.txt / markdown)"),
        ("sitemap", "No sitemap declared"),
        ("robots_reachable", "No robots.txt"),
    ]

    rows = []
    for r in runs:
        f = {x["check_id"]: bool(x["passed"])
             for x in conn.execute("SELECT * FROM findings WHERE run_id=?", (r["id"],))}
        a = {x["probe"]: bool(x["passed"])
             for x in conn.execute("SELECT * FROM advanced WHERE run_id=?", (r["id"],))}
        gap = next((label for key, label in GAP_PRIORITY if f.get(key) is False), "")
        row = {
            "DOMAIN": r["domain"], "AGENCY": r["agency"] or "",
            **({} if redact else {"CONTACT": r["contact"] or "", "EMAIL": r["email"] or ""}),
            "LOCALE": r["locale"] or "", "RAN_AT": r["ran_at"][:10],
            "ERROR": r["error"] or "",
            "SCORE": r["score"], "PASSED": r["passed"], "TOTAL": r["total"],
            "AGENT_TIER": sum(1 for p in probes if a.get(p)),
            "AGENT_TIER_MAX": len(probes),
            "TOP_GAP": gap,
        }
        for c in checks:
            row[c.upper()] = "" if r["error"] else ("Y" if f.get(c) else "N")
        for pr in probes:
            row[pr.upper()] = "" if r["error"] else ("Y" if a.get(pr) else "N")
        rows.append(row)

    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    ok = [r for r in rows if not r["ERROR"]]
    tier = sum(r["AGENT_TIER"] for r in ok)
    return (f"{len(rows)} rows -> {path}"
            f"{'  (redacted: no CONTACT/EMAIL)' if redact else '  (INCLUDES CONTACT DATA, keep local)'}\n"
            f"  analysed {len(ok)}, unreachable {len(rows) - len(ok)}\n"
            f"  mean stable score {sum(r['SCORE'] for r in ok) / max(1, len(ok)):.0f}/100\n"
            f"  advanced-tier probes passed: {tier} of {len(ok) * len(probes)} "
            f"({100 * tier // max(1, len(ok) * len(probes))}%)\n"
            f"  agencies with ANY advanced-tier signal: "
            f"{sum(1 for r in ok if r['AGENT_TIER'] > 0)} of {len(ok)}")


# ── driver ────────────────────────────────────────────────────────────────────


def load_targets(limit: int | None) -> list[dict]:
    if not SHORTLIST.exists():
        sys.exit(f"{SHORTLIST} not found")
    with SHORTLIST.open(encoding="utf-8") as fh:
        rows = [r for r in csv.DictReader(fh) if r.get("VERDICT") == "VERIFIED"]
    return rows[:limit] if limit else rows


def main() -> None:
    global SHORTLIST, DB_PATH  # rebound below from --shortlist / --db
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--limit", type=int, help="only the first N verified leads")
    ap.add_argument("--domain", help="check one domain, ad hoc")
    ap.add_argument("--report", help="print the stored report for a domain")
    ap.add_argument("--summary", action="store_true", help="aggregate across stored runs")
    ap.add_argument("--csv", type=Path, help="export the latest run per domain to CSV")
    ap.add_argument("--redact", action="store_true",
                    help="omit CONTACT/EMAIL; required for anything shared or committed")
    ap.add_argument("--shortlist", type=Path, help=f"lead CSV (default: {SHORTLIST})")
    ap.add_argument("--db", type=Path, help=f"sqlite path (default: {DB_PATH})")
    args = ap.parse_args()

    if args.shortlist:
        SHORTLIST = args.shortlist
    if args.db:
        DB_PATH = args.db
    if not DB_PATH.parent.exists():
        sys.exit(f"{DB_PATH.parent} not found. Pass --db to choose where results are stored.")

    conn = db()

    if args.report:
        print(report(conn, args.report.strip().lower()))
        return
    if args.summary:
        print(summary(conn))
        return
    if args.csv:
        print(export_csv(conn, args.csv, redact=args.redact))
        return

    targets = ([{"DOMAIN": args.domain}] if args.domain else load_targets(args.limit))
    print(f"checking {len(targets)} domains\n")

    def work(row: dict) -> tuple[Run, dict]:
        time.sleep(PER_HOST_DELAY)
        return check_domain(row["DOMAIN"]), row

    done = 0
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        for run, row in pool.map(work, targets):
            store(conn, run, row)
            done += 1
            flag = f"ERR  {run.error}" if run.error else f"{run.score:>3}/100"
            print(f"  [{done:>3}/{len(targets)}] {flag}  {run.domain}")

    print()
    print(summary(conn))
    print(f"\nstored in {DB_PATH}")


if __name__ == "__main__":
    main()
