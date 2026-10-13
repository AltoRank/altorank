// ---------------------------------------------------------------------------
// Scores and the report
// ---------------------------------------------------------------------------

import type { DecisionName, Scored } from "./types";
import { funnelTable } from "@/lib/keyword-research/topic-funnel";
import type { CaseFunnel } from "./funnel";
import type { PageTypeSummary } from "./decisions";

export interface LabelScore {
  label: string;
  /** Items labelled this. */
  support: number;
  /** Items the product answered this. */
  predicted: number;
  /** Of the items the product answered this, the share the label agrees with. Null when it never answered it. */
  precision: number | null;
  /** Of the items labelled this, the share the product got right. */
  recall: number | null;
}

export interface DecisionScore {
  decision: DecisionName;
  n: number;
  agreed: number;
  agreement: number | null;
  /** expected -> predicted -> count */
  matrix: Record<string, Record<string, number>>;
  labels: LabelScore[];
  /** Qualified on both sides with a labelled shape: how many shapes matched. */
  shape?: { n: number; agreed: number };
}

const ratio = (a: number, b: number): number | null => (b ? a / b : null);

export function scoreDecision(decision: DecisionName, items: Scored[]): DecisionScore {
  const matrix: Record<string, Record<string, number>> = {};
  for (const s of items) {
    matrix[s.expected] ??= {};
    matrix[s.expected][s.predicted] = (matrix[s.expected][s.predicted] ?? 0) + 1;
  }
  const names = [...new Set([...items.map((s) => s.expected), ...items.map((s) => s.predicted)])].sort();
  const labels = names.map((label) => {
    const labelled = items.filter((s) => s.expected === label);
    const answered = items.filter((s) => s.predicted === label);
    return {
      label,
      support: labelled.length,
      predicted: answered.length,
      precision: ratio(answered.filter((s) => s.agrees).length, answered.length),
      recall: ratio(labelled.filter((s) => s.agrees).length, labelled.length),
    };
  });
  const agreed = items.filter((s) => s.agrees).length;
  const shaped = items.filter((s) => s.shape);
  const out: DecisionScore = { decision, n: items.length, agreed, agreement: ratio(agreed, items.length), matrix, labels };
  if (shaped.length) out.shape = { n: shaped.length, agreed: shaped.filter((s) => s.shape!.expected === s.shape!.predicted).length };
  return out;
}

/**
 * How bad a disagreement is, for ordering: a good topic refused is the
 * failure that leaves a customer with nothing planned, so it comes first,
 * then a bad topic approved, then everything else; searched terms before
 * unsearched ones within each.
 */
export function severity(s: Scored): number {
  const refusedGood = (s.expected === "qualified" || s.expected === "keep") && s.predicted !== s.expected;
  const approvedBad = (s.predicted === "qualified" || s.predicted === "keep" || s.predicted === "supported") && s.expected !== s.predicted;
  return (refusedGood ? 2_000_000 : approvedBad ? 1_000_000 : 0) + Math.min(s.volume ?? 0, 999_999);
}

export function worstDisagreements(items: Scored[], limit: number): Scored[] {
  return items.filter((s) => !s.agrees).sort((a, b) => severity(b) - severity(a)).slice(0, limit);
}

const pct = (v: number | null) => (v === null ? "–" : `${Math.round(v * 100)}%`);
const cell = (text: string | null | undefined) => (text ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

export function renderMarkdown(input: {
  title: string;
  scores: DecisionScore[];
  items: Scored[];
  meta: Record<string, string | number>;
  worst?: number;
  /** The pipeline items as the planner's funnel, per case (./funnel.ts). */
  funnels?: readonly CaseFunnel[];
  /** The page-type rule's proof numbers (./decisions.ts `pageTypeSummary`). */
  pageType?: PageTypeSummary;
}): string {
  const lines: string[] = [`# ${input.title}`, ""];
  for (const [k, v] of Object.entries(input.meta)) lines.push(`- ${k}: ${v}`);
  lines.push("");
  for (const s of input.scores) {
    lines.push(`## ${s.decision}`, "", `Agreement with the labels: **${s.agreed}/${s.n} (${pct(s.agreement)})**`);
    if (s.shape) lines.push(`Shape, where both said qualified: ${s.shape.agreed}/${s.shape.n}`);
    const p = s.decision === "page-type" ? input.pageType : undefined;
    if (p) {
      lines.push(
        "",
        `Results read by the stored judge answer: ${p.byJudge}/${p.n} (the rest by the word lists).`,
        "",
        "| | before the rule | after the rule |",
        "|---|---:|---:|",
        `| agreement | ${p.agreement.before}/${p.n} | ${p.agreement.after}/${p.n} |`,
        `| needs_page labels read needs_page | ${p.needsPage.before}/${p.needsPage.labelled} | ${p.needsPage.after}/${p.needsPage.labelled} |`,
        `| qualified labels lost (needs_page / not_editorial) | ${p.qualifiedLost.before}/${p.qualifiedLost.labelled} | ${p.qualifiedLost.after}/${p.qualifiedLost.labelled} |`,
        `| published topics still qualified | ${p.published.keptBefore}/${p.published.labelled} | ${p.published.keptAfter}/${p.published.labelled} |`,
        "",
        `Qualified labels one page short of the needs-page threshold (${p.qualifiedAtEdge.threshold}) because of the page's own reading: ${p.qualifiedAtEdge.terms.length}${p.qualifiedAtEdge.terms.length ? ` (${p.qualifiedAtEdge.terms.join("; ")})` : ""}.`,
      );
    }
    lines.push("");
    const predictedCols = [...new Set(Object.values(s.matrix).flatMap((row) => Object.keys(row)))].sort();
    lines.push(`| label \\ product | ${predictedCols.join(" | ")} |`, `|---|${predictedCols.map(() => "---:").join("|")}|`);
    for (const [expected, row] of Object.entries(s.matrix).sort()) lines.push(`| ${expected} | ${predictedCols.map((p) => row[p] ?? 0).join(" | ")} |`);
    lines.push("", "| verdict | labelled | answered | precision | recall |", "|---|---:|---:|---:|---:|");
    for (const l of s.labels) lines.push(`| ${l.label} | ${l.support} | ${l.predicted} | ${pct(l.precision)} | ${pct(l.recall)} |`);
    lines.push("");
    const wrong = worstDisagreements(input.items.filter((i) => i.decision === s.decision), input.worst ?? 25);
    if (wrong.length) {
      lines.push(`### Disagreements (worst first, ${wrong.length} shown)`, "", "| case | item | label | product | product's reason | label note |", "|---|---|---|---|---|---|");
      for (const w of wrong) lines.push(`| ${cell(w.caseId)} | ${cell(w.item)} | ${w.expected} | ${w.predicted}${w.baseline && w.baseline !== w.predicted ? ` (was ${w.baseline})` : ""} | ${cell(w.reason)} | ${cell(w.note)} |`);
      lines.push("");
    }
  }
  if (input.funnels?.length) {
    lines.push("## funnel", "", "The end-to-end items as the planner's funnel (lib/keyword-research/topic-funnel.ts): what the labels say, and what the product made of it. The recommender's free gates are not in a case, so they are not here.", "");
    for (const f of input.funnels) lines.push(`### ${f.caseId}`, "", funnelTable([{ label: "labels", funnel: f.labels }, { label: "product", funnel: f.product }]), "");
  }
  return `${lines.join("\n")}\n`;
}
