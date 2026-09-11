"use client";

// ---------------------------------------------------------------------------
// The site report under the run: what the first look measured, to read while
// the draft is written
// ---------------------------------------------------------------------------
//
// Everything here is already in `domain_audits` by the time the drafting
// phase starts (lib/onboarding/first-look-report.ts maps the row). Sections
// are tabs: one panel at a time, so the report cannot push the screen's own
// call to action below the fold. Nothing is fetched from this component and
// nothing here changes the run. Numbers are judged where a threshold is a
// matter of record - Core Web Vitals against Google's published bands - and
// shown plain where it is not.

import { useState } from "react";

import { Icons } from "@/components/ui";
import type { FirstLookReport, ReportSpeed } from "@/lib/onboarding/first-look-report";
import type { PageFacts } from "@/lib/audit/page-facts";

type Tone = "ok" | "warn" | "err" | "muted";

/**
 * The readiness checks in words, with the fix. The same nine as the public
 * /check page (lib/public-check/shape.ts); repeated here rather than
 * imported because that module pulls the checker itself into the bundle.
 */
const CHECK_META: Record<string, { label: string; fix: string }> = {
  robots_reachable: { label: "robots.txt reachable", fix: "Publish a robots.txt at the site root so crawlers get explicit guidance." },
  ai_crawlers_allowed: { label: "AI crawlers allowed", fix: "Remove the Disallow rules that block the listed AI crawlers, or scope them to paths that should stay private." },
  sitemap: { label: "Sitemap declared", fix: "Add a Sitemap: line to robots.txt pointing at an XML sitemap that returns 200." },
  structured_data: { label: "Structured data on the homepage", fix: "Add JSON-LD to the homepage describing the page and the organisation behind it." },
  entity_schema: { label: "Organization schema", fix: "Add an Organization or LocalBusiness JSON-LD block with name, url and logo so the site resolves as an entity." },
  machine_readable: { label: "Machine-readable copy", fix: "Serve a plain-text /llms.txt listing the site's key pages, or offer a markdown version of each page." },
  title_meta: { label: "Title and meta description", fix: "Give the homepage a title and a meta description." },
  single_h1: { label: "Single h1", fix: "Use exactly one h1 on the homepage." },
  content_signals: { label: "Content signals", fix: "Optional: add a Content-Signal line to robots.txt stating your ai-train, search and ai-input preferences." },
};

const TONE_TEXT: Record<Tone, string> = { ok: "text-ok-ink", warn: "text-warn-ink", err: "text-err-ink", muted: "text-ink-3" };
const TONE_BG: Record<Tone, string> = { ok: "bg-ok-soft text-ok-ink", warn: "bg-warn-soft text-warn-ink", err: "bg-err-soft text-err-ink", muted: "bg-panel-2 text-ink-3" };
const TONE_STROKE: Record<Tone, string> = { ok: "stroke-ok", warn: "stroke-warn", err: "stroke-err", muted: "stroke-ink-4" };

/** Lighthouse's own bands: 90 green, 50 orange, below red. */
export function scoreTone(score: number | null): Tone {
  if (score === null) return "muted";
  if (score >= 90) return "ok";
  if (score >= 50) return "warn";
  return "err";
}

/** Google's Core Web Vitals bands. `poor` is the "needs improvement" ceiling. */
export function vitalTone(value: number, good: number, poor: number): Tone {
  if (value <= good) return "ok";
  if (value <= poor) return "warn";
  return "err";
}

const VITAL_LABEL: Record<Tone, string> = { ok: "Pass", warn: "Needs work", err: "Poor", muted: "" };

function ScoreRing({ value, label, size = 44 }: { value: number | null; label: string; size?: number }) {
  const tone = scoreTone(value);
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  const filled = value === null ? 0 : (Math.max(0, Math.min(100, value)) / 100) * c;
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={3} className="stroke-line" />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={3}
            strokeLinecap="round"
            strokeDasharray={`${filled} ${c - filled}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            className={TONE_STROKE[tone]}
          />
        </svg>
        <span className={`absolute inset-0 flex items-center justify-center font-mono text-[12px] ${TONE_TEXT[tone]}`}>
          {value === null ? "—" : value}
        </span>
      </div>
      <span className="text-[10.5px] text-ink-3">{label}</span>
    </div>
  );
}

function Section({ title, sub, meta, children }: { title: string; sub?: string; meta?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-[8px] border border-line bg-bg">
      <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
        <div className="min-w-0">
          <div className="text-[12.5px] font-medium text-ink">{title}</div>
          {sub && <div className="text-[11.5px] text-ink-3">{sub}</div>}
        </div>
        {meta && <div className="flex shrink-0 items-center gap-2 text-[11px] text-ink-3">{meta}</div>}
      </div>
      <div className="border-t border-line px-3.5 py-3">{children}</div>
    </div>
  );
}

function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`rounded-full px-1.5 py-px font-mono text-[10.5px] ${TONE_BG[tone]}`}>{children}</span>;
}

function Row({ label, value, tone = "muted", note }: { label: string; value: React.ReactNode; tone?: Tone; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-[12px]">
      <span className="text-ink-2">{label}</span>
      <span className={`text-right font-mono text-[11.5px] ${tone === "muted" ? "text-ink" : TONE_TEXT[tone]}`}>
        {value}
        {note && <span className="ml-1.5 font-sans text-[11px] text-ink-3">{note}</span>}
      </span>
    </div>
  );
}

// --- Sections --------------------------------------------------------------

function Readiness({ readiness }: { readiness: NonNullable<FirstLookReport["readiness"]> }) {
  const failed = readiness.findings.filter((f) => !f.passed && !f.inconclusive);
  const unknown = readiness.findings.filter((f) => f.inconclusive);
  const passed = readiness.findings.filter((f) => f.passed && !f.inconclusive);
  const ordered = [...failed, ...unknown, ...passed];
  return (
    <Section
      title="Can AI assistants read it"
      sub={readiness.partial ? "Some checks did not finish in time; the score covers the ones that did." : "robots.txt, sitemap, structured data, machine-readable copy"}
      meta={<Pill tone={scoreTone(readiness.score)}>{readiness.score}/100</Pill>}
    >
      {readiness.error && <p className="m-0 mb-2 text-[12px] text-err-ink">{readiness.error}</p>}
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {ordered.map((f) => {
          const tone: Tone = f.inconclusive ? "muted" : f.passed ? "ok" : f.severity === "low" ? "warn" : "err";
          return (
            <li key={f.check} className="flex items-start gap-2 text-[12px]">
              <span className={`mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full ${TONE_BG[tone]}`}>
                {f.passed && !f.inconclusive ? <Icons.check size={9} /> : f.inconclusive ? <Icons.question size={9} /> : <Icons.x size={9} />}
              </span>
              <div className="min-w-0">
                <span className="text-ink">{CHECK_META[f.check]?.label ?? f.check}</span>
                {f.detail && <span className="text-ink-3"> · {f.detail}</span>}
                {!f.passed && !f.inconclusive && CHECK_META[f.check]?.fix && (
                  <div className="mt-0.5 text-[11.5px] text-ink-3">{CHECK_META[f.check].fix}</div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);

function Speed({ speed }: { speed: ReportSpeed }) {
  if (!speed.ok) {
    return (
      <Section title="Speed" sub="Lighthouse, mobile" meta={<Pill tone="muted">not measured</Pill>}>
        <p className="m-0 text-[12px] text-ink-3">{speed.detail}</p>
      </Section>
    );
  }
  const vitals: Array<{ label: string; value: string; tone: Tone }> = [
    { label: "LCP", value: ms(speed.lcpMs), tone: vitalTone(speed.lcpMs, 2500, 4000) },
    { label: "FCP", value: ms(speed.fcpMs), tone: vitalTone(speed.fcpMs, 1800, 3000) },
    { label: "TBT", value: ms(speed.tbtMs), tone: vitalTone(speed.tbtMs, 200, 600) },
    { label: "CLS", value: speed.cls.toFixed(3), tone: vitalTone(speed.cls, 0.1, 0.25) },
  ];
  return (
    <Section title="Speed" sub="Lighthouse lab run, mobile. Real visitors may differ." meta={<Pill tone={scoreTone(speed.performance)}>{speed.performance}</Pill>}>
      <div className="grid grid-cols-4 gap-2">
        <ScoreRing value={speed.performance} label="Performance" />
        <ScoreRing value={speed.accessibility} label="Accessibility" />
        <ScoreRing value={speed.bestPractices} label="Best practices" />
        <ScoreRing value={speed.seo} label="SEO" />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {vitals.map((v) => (
          <div key={v.label} className="rounded-[6px] border border-line px-2.5 py-2">
            <div className="text-[10.5px] text-ink-3">{v.label}</div>
            <div className={`font-mono text-[13px] ${TONE_TEXT[v.tone]}`}>{v.value}</div>
            <div className="text-[10.5px] text-ink-3">{VITAL_LABEL[v.tone]}</div>
          </div>
        ))}
      </div>
    </Section>
  );
}

const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`;

function Homepage({ page }: { page: PageFacts }) {
  const titleTone: Tone = !page.title ? "err" : page.titleLength > 60 || page.titleLength < 25 ? "warn" : "ok";
  const descTone: Tone = !page.metaDescription ? "err" : page.metaDescriptionLength > 160 || page.metaDescriptionLength < 70 ? "warn" : "ok";
  const h1Tone: Tone = page.headings.h1 === 1 ? "ok" : page.headings.h1 === 0 ? "err" : "warn";
  const blocking = page.renderBlockingScripts + page.renderBlockingStylesheets;
  const maxH = Math.max(1, page.headings.h1, page.headings.h2, page.headings.h3, page.headings.h4);
  const socialTone: Tone = page.socialTags.length >= 4 ? "ok" : page.socialTags.length ? "warn" : "err";
  return (
    <Section title="The homepage, as fetched" sub="Read off the response we already had; no second request">
      <div className="divide-y divide-line">
        <Row label="Server" value={page.server ?? "not stated"} />
        <Row label="Status" value={page.status} tone={page.status >= 200 && page.status < 300 ? "ok" : "err"} />
        <Row label="Compression" value={page.encoding ?? "none"} tone={page.encoding ? "ok" : "warn"} />
        <Row label="HTML size" value={kb(page.htmlBytes)} tone={page.htmlBytes > 300_000 ? "warn" : "muted"} />
        <Row label="Words share of the page" value={`${page.textRatio}%`} tone={page.textRatio < 10 ? "warn" : "muted"} note={page.textRatio < 10 ? "mostly markup and scripts" : undefined} />
        <Row label="Cacheable" value={page.cacheable === null ? "not stated" : page.cacheable ? "yes" : "no"} tone={page.cacheable === false ? "warn" : "muted"} />
        <Row label="Title" value={`${page.titleLength} chars`} tone={titleTone} note={!page.title ? "missing" : page.titleLength > 60 ? "over 60, Google trims it" : undefined} />
        <Row label="Meta description" value={`${page.metaDescriptionLength} chars`} tone={descTone} note={!page.metaDescription ? "missing" : page.metaDescriptionLength > 160 ? "over 160, Google trims it" : undefined} />
        <Row label="Viewport meta" value={page.viewport ? "set" : "missing"} tone={page.viewport ? "ok" : "err"} />
        <Row label="Canonical" value={page.canonical ? "set" : "missing"} tone={page.canonical ? "ok" : "warn"} />
        <Row label="Language" value={page.lang ?? "not declared"} tone={page.lang ? "muted" : "warn"} />
        <Row label="Structured data" value={page.schemaTypes.length ? page.schemaTypes.slice(0, 4).join(", ") : "none"} tone={page.schemaTypes.length ? "ok" : "warn"} />
        <Row label="Social tags" value={`${page.socialTags.length} set`} tone={socialTone} note={page.socialTags.length ? undefined : "no og: or twitter: tags"} />
        <Row label="Render-blocking in <head>" value={`${page.renderBlockingScripts} scripts, ${page.renderBlockingStylesheets} stylesheets`} tone={blocking > 3 ? "warn" : "muted"} />
        <Row label="Images without alt" value={`${page.images.missingAlt} of ${page.images.total}`} tone={page.images.missingAlt ? "warn" : "ok"} />
      </div>
      <div className="mt-3">
        <div className="mb-1.5 text-[11px] uppercase tracking-wide text-ink-3">Headings</div>
        <div className="flex flex-col gap-1">
          {(["h1", "h2", "h3", "h4"] as const).map((h) => {
            const n = page.headings[h];
            const tone: Tone = h === "h1" ? h1Tone : "muted";
            return (
              <div key={h} className="flex items-center gap-2 text-[11.5px]">
                <span className="w-6 font-mono uppercase text-ink-3">{h}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel-2">
                  <div className={`h-full rounded-full ${tone === "ok" || tone === "muted" ? "bg-accent" : tone === "warn" ? "bg-warn" : "bg-err"}`} style={{ width: `${(100 * n) / maxH}%` }} />
                </div>
                <span className={`w-6 text-right font-mono ${TONE_TEXT[tone]}`}>{n}</span>
              </div>
            );
          })}
        </div>
        {page.headings.h1 !== 1 && (
          <p className="m-0 mt-1.5 text-[11.5px] text-ink-3">
            {page.headings.h1 === 0 ? "No H1: the page has no stated subject for a crawler to read first." : `${page.headings.h1} H1 tags: one per page is the convention search engines expect.`}
          </p>
        )}
      </div>
    </Section>
  );
}

const ISSUE_LABEL: Record<string, string> = {
  broken_link: "Broken links",
  missing_meta: "Pages without a meta description",
  missing_alt: "Images without alt text",
  heading_hierarchy: "Heading problems",
  slow_page: "Slow pages",
  tls_chain: "Incomplete TLS chain",
  fetch_failed: "Pages that could not be fetched",
};

function Issues({ report }: { report: FirstLookReport }) {
  const total = report.issues.reduce((n, g) => n + g.count, 0);
  return (
    <Section
      title="What the crawl found"
      sub={`${report.pagesCrawled} page${report.pagesCrawled === 1 ? "" : "s"} read${report.onPageScore !== null ? `, on-page score ${report.onPageScore}` : ""}`}
      meta={<Pill tone={total === 0 ? "ok" : report.issues.some((g) => g.severity === "error") ? "err" : "warn"}>{total === 0 ? "clean" : `${total} issue${total === 1 ? "" : "s"}`}</Pill>}
    >
      {total === 0 ? (
        <p className="m-0 text-[12px] text-ink-3">Nothing mechanically wrong on the pages read.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {report.issues.map((g) => (
            <li key={g.type} className="flex items-start justify-between gap-3 text-[12px]">
              <div className="min-w-0">
                <span className="text-ink">{ISSUE_LABEL[g.type] ?? g.type}</span>
                <div className="truncate text-[11.5px] text-ink-3">{g.example}</div>
              </div>
              <Pill tone={g.severity === "error" ? "err" : g.severity === "warning" ? "warn" : "muted"}>{g.count}</Pill>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function ExistingPages({ pages }: { pages: NonNullable<FirstLookReport["existingPages"]> }) {
  return (
    <Section
      title="Your existing pages"
      sub={`${pages.checked} checked, ${pages.withIssues} with something to fix`}
      meta={<Pill tone={pages.withIssues === 0 ? "ok" : "warn"}>{pages.withIssues === 0 ? "clean" : `${pages.withIssues} to fix`}</Pill>}
    >
      {pages.worst.length === 0 ? (
        <p className="m-0 text-[12px] text-ink-3">Every page checked passed its technical checks.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {pages.worst.map((p) => (
            <li key={p.url} className="flex items-start justify-between gap-3 text-[12px]">
              <div className="min-w-0">
                <div className="truncate text-ink">{p.title || p.url}</div>
                {p.title && <div className="truncate text-[11px] text-ink-3">{p.url}</div>}
              </div>
              <Pill tone="warn">{p.techIssueCount}</Pill>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// --- The report ------------------------------------------------------------

export function FirstLookReportView({ report, domain, live }: { report: FirstLookReport | null; domain: string; live: boolean }) {
  const [active, setActive] = useState(0);
  if (!report) {
    if (!live) return null;
    return (
      <div className="rounded-[8px] border border-dashed border-line px-3.5 py-3 text-[12px] text-ink-3">
        A report on {domain} appears here once the site has been read: whether AI assistants can read it, how fast it is, what the pages need.
      </div>
    );
  }
  // Label, then panel. The label is what a person scans across the row, so it
  // is the plain-language name of the thing measured, not the section title.
  const tabs: { id: string; label: string; node: React.ReactNode }[] = [
    report.readiness && { id: "readiness", label: "AI readability", node: <Readiness readiness={report.readiness} /> },
    report.speed && { id: "speed", label: "Speed", node: <Speed speed={report.speed} /> },
    report.page && { id: "page", label: "Homepage", node: <Homepage page={report.page} /> },
    (report.pagesCrawled > 0 || report.issues.length > 0) && { id: "issues", label: "Crawl", node: <Issues report={report} /> },
    report.existingPages && { id: "existing", label: "Your pages", node: <ExistingPages pages={report.existingPages} /> },
  ].filter(Boolean) as { id: string; label: string; node: React.ReactNode }[];
  if (!tabs.length) return null;
  // A tab that disappears between renders (the run is still filling the report
  // in) must not leave the panel blank.
  const current = tabs[Math.min(active, tabs.length - 1)];
  return (
    <div className="flex flex-col gap-2.5" data-testid="first-look-report">
      <div>
        <div className="text-[12.5px] font-medium text-ink">{domain}, as we read it</div>
        <p className="m-0 text-[11.5px] text-ink-3">
          {live ? "Something to read while the first draft is written. " : ""}
          Measured on the site&apos;s public pages; nothing here needed an account.
        </p>
      </div>
      <div role="tablist" aria-label={`${domain} report`} className="-mx-1 flex flex-wrap gap-1 overflow-x-auto px-1">
        {tabs.map((t, i) => {
          const on = t.id === current.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setActive(i)}
              className={`shrink-0 rounded-full border px-2.5 py-1 text-[11.5px] transition-colors ${
                on ? "border-accent/40 bg-accent/10 text-ink" : "border-line bg-bg text-ink-3 hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel">{current.node}</div>
    </div>
  );
}
