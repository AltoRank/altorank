"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Icons } from "@/components/ui/icons";
import { cn, plural } from "@/lib/utils";
import { TECH_CHECK_INFO, type TechFinding, type TechSeverity } from "@/lib/seo/tech-audit";

/** One crawled page and what was wrong with it. */
export interface TechPageRow {
  id: string;
  url: string;
  title: string | null;
  findings: TechFinding[];
}

const SEVERITY_TONE: Record<TechSeverity, string> = {
  error: "bg-err-soft text-err-ink",
  warning: "bg-warn-soft text-warn-ink",
  info: "bg-panel-2 text-ink-2",
};

const SEVERITY_RANK: Record<TechSeverity, number> = { error: 0, warning: 1, info: 2 };

/** Worst first, then whatever affects the most pages. */
function group(pages: TechPageRow[]) {
  const byCode = new Map<string, { code: string; severity: TechSeverity; pages: Array<{ page: TechPageRow; message: string }> }>();
  for (const page of pages) {
    for (const f of page.findings) {
      const entry = byCode.get(f.code);
      if (entry) entry.pages.push({ page, message: f.message });
      else byCode.set(f.code, { code: f.code, severity: f.severity, pages: [{ page, message: f.message }] });
    }
  }
  return [...byCode.values()].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.pages.length - a.pages.length,
  );
}

/**
 * What is mechanically wrong with the pages the customer already published.
 *
 * Deliberately its own card, above the rewrites, and deliberately worded to
 * say where it came from. The rest of this page is about pages that rank:
 * every candidate is scored from Search Console impressions, and with no
 * Search Console the page is four blockers and two empty tables. This half
 * needs no connection at all - it is the crawl reading markup - and if the two
 * were not told apart a customer would reasonably read "we found 62 things
 * wrong" as "we know how you rank", which we do not.
 *
 * It also does not offer to fix anything, because nothing here writes to a
 * site. A missing meta description is a change in their CMS; the rewrites
 * below are drafts we produce. Putting a "Fix" button on this list would
 * promise the one thing this feature does not do.
 */
export function TechnicalIssues({
  pages,
  pagesChecked,
  checkedAt,
}: {
  pages: TechPageRow[];
  /** Every page the crawl read, including the clean ones. */
  pagesChecked: number;
  checkedAt: string | null;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const groups = group(pages);
  const total = groups.reduce((n, g) => n + g.pages.length, 0);

  return (
    <Card
      title="Technical issues on your existing pages"
      meta={
        checkedAt
          ? `${plural(pagesChecked, "page")} read ${new Date(checkedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
          : undefined
      }
      flush
    >
      <p className="m-0 px-[18px] pt-3 text-[12.5px] leading-[1.6] text-ink-3">
        {/* The distinction the copy has to carry. Both halves of this page
            list things to do about a URL, and they come from opposite
            evidence: this one from reading the page, the ones below from how
            it ranks. */}
        Found by fetching your published pages and reading their markup — no Search Console needed. These are
        changes to make in your CMS; the rewrites below are drafts we write for pages that already rank.
      </p>

      {pagesChecked === 0 ? (
        <div className="px-[18px] py-8 text-center text-[13px] text-ink-3">
          {/* Never "0 issues": nothing has been read, and a zero here would
              read as a clean bill of health (CLAUDE.md rule 5). */}
          Your pages have not been read yet. This runs during onboarding and again on the nightly pass.
        </div>
      ) : total === 0 ? (
        <div className="px-[18px] py-8 text-center text-[13px] text-ink-3">
          Nothing mechanically wrong across {plural(pagesChecked, "page")}.
        </div>
      ) : (
        <ul className="m-0 mt-3 list-none p-0 divide-y divide-line-soft border-t border-line-soft">
          {groups.map((g) => {
            const info = TECH_CHECK_INFO[g.code as keyof typeof TECH_CHECK_INFO];
            const expanded = open === g.code;
            return (
              <li key={g.code}>
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? null : g.code)}
                  aria-expanded={expanded}
                  className="flex w-full items-start gap-3 px-[18px] py-3 text-left hover:bg-panel"
                >
                  <span
                    className={cn(
                      "mt-px inline-flex shrink-0 rounded-full px-[7px] py-px text-[11px] font-medium",
                      SEVERITY_TONE[g.severity],
                    )}
                  >
                    {g.severity}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-ink">{info?.label ?? g.code}</span>
                    <span className="mt-0.5 block text-[12px] leading-[1.55] text-ink-3">{info?.why}</span>
                  </span>
                  <span className="shrink-0 font-mono text-[12px] text-ink-2">{plural(g.pages.length, "page")}</span>
                  <span className={cn("mt-0.5 shrink-0 text-ink-3 transition-transform", expanded && "rotate-180")}>
                    <Icons.caretDown size={13} />
                  </span>
                </button>
                {expanded && (
                  <ul className="m-0 list-none border-t border-line-soft bg-panel px-[18px] py-2 pl-[52px]">
                    {g.pages.map(({ page, message }) => (
                      <li key={page.id} className="py-1.5">
                        <a
                          href={page.url}
                          target="_blank"
                          rel="noreferrer"
                          className="block truncate font-mono text-[11.5px] text-ink-2 hover:underline"
                        >
                          {page.url.replace(/^https?:\/\//, "")}
                        </a>
                        <span className="mt-0.5 block text-[12px] text-ink-3">{message}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
