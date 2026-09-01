// The "email me the full plan" body. Plain HTML, no images, every line the
// same fact the page showed, plus the generated fixes the page only counted.
// Escaped here because the plan carries strings from the SERP index and a
// stranger's homepage, neither of which is ours.

import type { GrowthPlan } from "./build";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const n = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toLocaleString("en-US"));

export function growthPlanSubject(plan: GrowthPlan): string {
  return `Growth plan for ${plan.domain}`;
}

export function renderGrowthPlanEmail(plan: GrowthPlan, signupUrl: string): string {
  const h2 = (t: string) => `<h2 style="font-size:16px;margin:28px 0 8px">${t}</h2>`;
  const p = (t: string) => `<p style="font-size:14px;line-height:1.5;color:#444;margin:0 0 8px">${t}</p>`;
  const li = (t: string) => `<li style="font-size:14px;line-height:1.6">${t}</li>`;

  const wins = plan.closestWins.length
    ? `<ul>${plan.closestWins.map((w) => li(`<strong>${esc(w.keyword)}</strong> — position ${w.position}, ${n(w.volume)} searches/mo, earned by <code>${esc(w.path)}</code>`)).join("")}</ul>`
    : p(plan.rankingKeywords ? "Nothing sitting on page two right now." : "Nothing ranking yet, so every article is a first one.");

  const gaps = plan.gaps.length
    ? `<ul>${plan.gaps.map((g) => li(`<strong>${esc(g.keyword)}</strong> — ${n(g.volume)}/mo, ranked by ${g.rankedBy.map((r) => `${esc(r.domain)} at #${r.position}`).join(", ")}`)).join("")}</ul>`
    : p(plan.competitors.length ? "Nothing on page one for your competitors that you lack." : "No domain shares enough ranking keywords with yours yet to compare against.");

  const failing = plan.readiness.failing;
  const artifacts = plan.readiness.artifacts;
  const readiness = plan.readiness.error
    ? p(esc(plan.readiness.error))
    : p(`Score <strong>${plan.readiness.score}/100</strong>. ${failing.length ? `Failing: ${failing.map((f) => esc(f.check.replace(/_/g, " "))).join(", ")}.` : "Every check passes."}`) +
      artifacts
        .map((a) =>
          a.body
            ? `<p style="font-size:13px;margin:16px 0 4px"><strong>${esc(a.name)}</strong> — ${esc(a.placement)}</p><pre style="font-size:12px;background:#f6f6f6;padding:12px;overflow:auto;white-space:pre-wrap">${esc(a.body)}</pre>`
            : `<p style="font-size:13px;margin:12px 0 4px"><strong>${esc(a.name.replace(/_/g, " "))}</strong> — ${esc(a.placement)}</p>`,
        )
        .join("");

  const c = plan.cadence;
  return [
    `<h1 style="font-size:22px;margin:0 0 4px">Growth plan for ${esc(plan.domain)}</h1>`,
    p(`Generated ${new Date(plan.generatedAt).toUTCString()} from public data: what the site ranks for, who else ranks for it, and whether AI assistants can read it.`),
    h2("Closest wins"), p("Terms you already rank for on page two. One revision from page one."), wins,
    h2("Gaps"), p(plan.competitors.length ? `What ${plan.competitors.map((x) => esc(x.domain)).join(" and ")} rank for on page one and you do not.` : "Competitor comparison."), gaps,
    h2("Can AI read your site?"), readiness,
    h2("The plan"),
    p(`${c.articlesPerMonth} articles a month${c.firstTargets.length ? `, starting with ${c.firstTargets.map(esc).join(", ")}` : ""}. First one published in ${c.firstPublishDays} working days, after you approve it.`),
    `<p style="margin:20px 0"><a href="${esc(signupUrl)}?domain=${encodeURIComponent(plan.domain)}" style="display:inline-block;background:#111;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-size:14px">Start publishing against this plan</a></p>`,
  ].join("\n");
}
