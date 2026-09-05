import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";
import { checkToolRateLimit } from "@/lib/tools/rate-limit";
import { clientIp } from "@/lib/growth-plan/http";
import { parsePublicDomain } from "@/lib/public-check/domain";
import { loadCachedCheck, runPublicCheck, storeCheck } from "@/lib/public-check/run";
import {
  scoreLabel,
  shortDate,
  badgeText,
  APP_URL,
  type PublicCheck,
  type PublicCheckData,
} from "@/lib/public-check/shape";
import { OSS_REPO_PUBLIC, OSS_REPO_URL } from "@/lib/constants";
import { RerunButton } from "./rerun-button";

/**
 * app.altorank.co/check/<domain>: the shareable result of the free check.
 *
 * Public, no login. Serves the cached result when there is one; otherwise
 * runs the check once, under the same per-IP limit as the API, so a link to
 * a domain nobody has checked still resolves to a real answer. Not indexed:
 * one page per arbitrary domain is exactly the thin programmatic surface a
 * search engine should not be asked to rank.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000;

type Props = { params: Promise<{ domain: string }> };

async function domainFrom(props: Props): Promise<string | null> {
  const { domain } = await props.params;
  let raw = domain;
  try {
    raw = decodeURIComponent(domain);
  } catch {
    return null;
  }
  const parsed = parsePublicDomain(raw);
  return parsed.ok ? parsed.domain : null;
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const domain = await domainFrom(props);
  if (!domain) return { title: "AI-readiness check" };
  const cached = await loadCachedCheck(createServiceClient(), domain);
  const description = cached
    ? cached.score === null
      ? `AltoRank could not complete the AI-readiness check for ${domain}.`
      : `${cached.passed} of ${cached.known} AI-readiness checks pass for ${domain}. Checked ${shortDate(cached.checked_at)} by AltoRank.`
    : `Can an AI agent read ${domain}? Nine checks on its public configuration, by AltoRank.`;
  return {
    title: `AI-readiness check: ${domain}`,
    description,
    robots: { index: false, follow: true },
    openGraph: { title: `AI-readiness check: ${domain}`, description, type: "website" },
    twitter: { card: "summary_large_image", title: `AI-readiness check: ${domain}`, description },
  };
}

type Loaded =
  | { kind: "result"; data: PublicCheckData; cached: boolean }
  | { kind: "limited" };

async function load(domain: string): Promise<Loaded> {
  const supabase = createServiceClient();
  const cached = await loadCachedCheck(supabase, domain);
  if (cached) return { kind: "result", data: cached, cached: true };

  const ip = clientIp(await headers());
  if (!checkToolRateLimit("public-readiness", ip, RATE_LIMIT, RATE_WINDOW_MS)) {
    return { kind: "limited" };
  }
  const data = await runPublicCheck(domain);
  await storeCheck(supabase, data);
  return { kind: "result", data, cached: false };
}

const STATUS_STYLE: Record<PublicCheck["status"], { label: string; cls: string }> = {
  pass: { label: "Pass", cls: "bg-ok-soft text-ok-ink" },
  fail: { label: "Fail", cls: "bg-err-soft text-err-ink" },
  unknown: { label: "Unknown", cls: "bg-panel-2 text-ink-3" },
};

export default async function CheckPage(props: Props) {
  const domain = await domainFrom(props);
  if (!domain) notFound();

  const loaded = await load(domain);

  if (loaded.kind === "limited") {
    return (
      <section className="rounded-xl border border-line bg-bg p-6">
        <h1 className="m-0 text-[22px] font-semibold tracking-[-0.02em]">{domain}</h1>
        <p className="mt-2 text-[14px] text-ink-2">
          This domain has not been checked recently and this connection has already run {RATE_LIMIT} checks
          in the last hour. Try again later, or open the link from another connection.
        </p>
      </section>
    );
  }

  const { data, cached } = loaded;
  const failing = data.checks.filter((c) => c.status === "fail");
  const unknown = data.checks.filter((c) => c.status === "unknown");
  const signupHref = `/signup?domain=${encodeURIComponent(domain)}`;
  const jsonHref = `/api/public/readiness?domain=${encodeURIComponent(domain)}`;
  const snippet = `<script src="${APP_URL}/check/badge.js?domain=${encodeURIComponent(domain)}" async></script>`;

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-xl border border-line bg-bg p-6">
        <p className="m-0 text-[13px] text-ink-3">Can an AI agent read this site?</p>
        <h1 className="mt-1 mb-4 text-[26px] font-semibold tracking-[-0.02em] break-all">{domain}</h1>

        {data.error ? (
          <p className="m-0 text-[15px] text-ink-2">
            The site could not be checked: {data.error}. Nothing below was measured.
          </p>
        ) : (
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="flex items-baseline gap-2">
                <span className="text-[44px] font-semibold leading-none tracking-[-0.03em]">
                  {data.score === null ? "?" : data.score}
                </span>
                <span className="text-[15px] text-ink-3">/100</span>
                <span className="ml-2 text-[15px] font-medium text-ink-2">{scoreLabel(data.score)}</span>
              </div>
              <p className="mt-2 mb-0 text-[13.5px] text-ink-2">
                {data.passed} of {data.known} completed checks pass
                {unknown.length > 0 && `, ${unknown.length} could not be decided`}. Checked {shortDate(data.checked_at)}
                {cached ? ", served from the six-hour cache" : ""}.
                {data.partial && " The site was slow to answer; checks that did not finish are marked unknown."}
              </p>
            </div>
            <RerunButton domain={domain} />
          </div>
        )}
      </section>

      <section className="rounded-xl border border-line bg-bg">
        <ul className="m-0 list-none divide-y divide-line-soft p-0">
          {data.checks.map((c) => {
            const s = STATUS_STYLE[c.status];
            return (
              <li key={c.id} className="flex gap-4 px-6 py-4">
                <span className={`mt-0.5 inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-[11.5px] font-semibold ${s.cls}`}>
                  {s.label}
                </span>
                <div className="min-w-0">
                  <p className="m-0 text-[14.5px] font-semibold">{c.label}</p>
                  {c.evidence && <p className="mt-0.5 mb-0 text-[13px] text-ink-2">{c.evidence}</p>}
                  {!c.evidence && c.status === "unknown" && (
                    <p className="mt-0.5 mb-0 text-[13px] text-ink-3">Not checked: the run stopped before this one.</p>
                  )}
                  {c.fix_summary && <p className="mt-1 mb-0 text-[13px] text-ink">Fix: {c.fix_summary}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="rounded-xl border border-line bg-bg p-6">
        <h2 className="m-0 text-[17px] font-semibold tracking-[-0.015em]">What this means</h2>
        <p className="mt-2 mb-0 text-[14px] leading-relaxed text-ink-2">
          AI assistants read a site the way a crawler does: they need permission in robots.txt, a map of the pages,
          structured data that says what the organisation is, and ideally a plain-text copy of the content. Each row
          above is one of those requirements, checked against what the site actually serves. A fail is something the
          site owner can change today; an unknown means the server did not give a clear answer and nothing is being
          claimed about it. The score weights crawler access and structured data above titles and headings, because a
          blocked crawler reads nothing at all.
        </p>
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-line bg-bg p-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="m-0 text-[15px] font-semibold">
            {failing.length > 0 ? `Fix ${failing.length === 1 ? "this" : `these ${failing.length}`} with AltoRank` : "Keep it this way with AltoRank"}
          </p>
          <p className="mt-1 mb-0 text-[13px] text-ink-2">
            Add the domain and it generates the schema and llms.txt for you to review. Open source; self-host it free.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <a href={signupHref} className="inline-flex h-10 items-center rounded-md bg-accent px-4 text-[13.5px] font-medium text-white hover:bg-accent-2">
            Fix these with AltoRank
          </a>
          {OSS_REPO_PUBLIC && (
            <a
              href={OSS_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-10 items-center rounded-md border border-line bg-bg px-4 text-[13.5px] font-medium text-ink hover:bg-panel"
            >
              Self-host it
            </a>
          )}
        </div>
      </section>

      {!data.error && (
        <section className="rounded-xl border border-line bg-bg p-6">
          <h2 className="m-0 text-[15px] font-semibold tracking-[-0.015em]">Show this result on your site</h2>
          <p className="mt-1 mb-3 text-[13px] text-ink-2">
            A small badge that reads <span className="font-mono text-[12px]">{badgeText(data)}</span> and links here. It shows
            only what was measured, and updates when you re-run the check.
          </p>
          <pre className="m-0 overflow-x-auto rounded-md border border-line-soft bg-panel p-3 font-mono text-[12px]">{snippet}</pre>
        </section>
      )}

      <p className="m-0 text-[12.5px] text-ink-3">
        <a href={jsonHref} className="underline decoration-line underline-offset-[3px] hover:text-ink">This result as JSON</a>
        {" · "}
        <a href="https://altorank.co/check" className="underline decoration-line underline-offset-[3px] hover:text-ink">Check another domain</a>
      </p>
    </div>
  );
}
