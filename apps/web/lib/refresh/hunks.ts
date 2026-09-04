// ---------------------------------------------------------------------------
// Block-level diff between two versions of an article
// ---------------------------------------------------------------------------
//
// A rewrite is reviewed one block at a time: this paragraph, that heading,
// this list. Character diffs are the wrong grain for prose (a reworded
// sentence lights up the whole paragraph anyway) and a whole-document
// accept/reject is the wrong grain for trust (one bad paragraph should not
// cost the reviewer the twelve good ones).
//
// So: split both sides into top-level blocks, run a longest-common-subsequence
// over them, and pair up the deletions and insertions that sit next to each
// other into "changed" hunks. No dependency: the arrays are a few dozen
// entries long and LCS over that is instant.
//
// `applyDecisions` is the only function that produces HTML somebody could
// publish, and it is conservative by construction: a hunk with no decision
// keeps the original. Nothing the model wrote reaches the site unless a
// person accepted that specific block.

import type { ExecutionDecisions, Hunk, HunkDecision } from "./types";

// ── Splitting ───────────────────────────────────────────────────────────────

const BLOCK_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "table", "blockquote",
  "pre", "figure", "hr", "img", "div", "section", "iframe", "aside", "dl",
]);
const VOID_TAGS = new Set(["hr", "img", "br", "iframe"]);

/**
 * Top-level blocks of an HTML fragment, in order. Text that sits outside any
 * block becomes a paragraph, so nothing is silently dropped from either side.
 */
export function splitBlocks(html: string): string[] {
  const out: string[] = [];
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?>/g;
  let i = 0;
  let depthTag: string | null = null;
  let depth = 0;
  let blockStart = 0;
  let stray = "";

  const flushStray = () => {
    const t = stray.trim();
    if (t) out.push(`<p>${t}</p>`);
    stray = "";
  };

  for (const m of html.matchAll(tagRe)) {
    const raw = m[0];
    const tag = m[1].toLowerCase();
    const at = m.index ?? 0;
    const closing = raw.startsWith("</");
    const selfClosing = raw.endsWith("/>") || VOID_TAGS.has(tag);

    if (depthTag === null) {
      // Between blocks.
      stray += html.slice(i, at);
      if (!closing && BLOCK_TAGS.has(tag)) {
        flushStray();
        if (selfClosing) {
          out.push(raw);
        } else {
          depthTag = tag;
          depth = 1;
          blockStart = at;
        }
      } else {
        // An inline tag or a stray close outside any block: keep it as text.
        stray += raw;
      }
      i = at + raw.length;
      continue;
    }

    // Inside a block: only the same tag changes the depth (ul inside ul).
    if (tag === depthTag && !selfClosing) {
      depth += closing ? -1 : 1;
      if (depth === 0) {
        out.push(html.slice(blockStart, at + raw.length));
        depthTag = null;
        i = at + raw.length;
      }
    }
  }
  if (depthTag !== null) {
    // Unclosed block: take the rest as-is.
    out.push(html.slice(blockStart));
  } else {
    stray += html.slice(i);
    flushStray();
  }
  return out.map((b) => b.trim()).filter(Boolean);
}

/**
 * What two blocks are compared on: whitespace-insensitive markup. Spaces
 * beside a tag boundary are dropped too, so a pretty-printed paragraph and
 * a compact one read as the same block. Comparison only; the stored hunk
 * keeps the original text.
 */
export function normalizeBlock(block: string): string {
  return block.replace(/\s+/g, " ").replace(/>\s/g, ">").replace(/\s</g, "<").trim();
}

// ── Diff ────────────────────────────────────────────────────────────────────

type Op = { kind: "equal" | "delete" | "insert"; before?: string; after?: string };

function lcsOps(a: string[], b: string[]): Op[] {
  const na = a.map(normalizeBlock);
  const nb = b.map(normalizeBlock);
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i..] and b[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = na[i] === nb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (na[i] === nb[j]) {
      ops.push({ kind: "equal", before: a[i], after: b[j] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "delete", before: a[i] });
      i++;
    } else {
      ops.push({ kind: "insert", after: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "delete", before: a[i++] });
  while (j < m) ops.push({ kind: "insert", after: b[j++] });
  return ops;
}

/**
 * Hunks between two HTML fragments. Adjacent runs of deletions and insertions
 * are paired positionally into `changed` hunks; whatever is left over in the
 * longer run is `removed` or `added`.
 */
export function diffBlocks(beforeHtml: string, afterHtml: string): Hunk[] {
  const ops = lcsOps(splitBlocks(beforeHtml), splitBlocks(afterHtml));
  const hunks: Hunk[] = [];
  let n = 0;
  const id = () => `h${++n}`;

  let k = 0;
  while (k < ops.length) {
    const op = ops[k];
    if (op.kind === "equal") {
      hunks.push({ id: id(), kind: "unchanged", before: op.before!, after: op.after! });
      k++;
      continue;
    }
    // Collect the run of non-equal ops.
    const dels: string[] = [];
    const ins: string[] = [];
    while (k < ops.length && ops[k].kind !== "equal") {
      if (ops[k].kind === "delete") dels.push(ops[k].before!);
      else ins.push(ops[k].after!);
      k++;
    }
    const paired = Math.min(dels.length, ins.length);
    for (let p = 0; p < paired; p++) {
      hunks.push({ id: id(), kind: "changed", before: dels[p], after: ins[p] });
    }
    for (let p = paired; p < dels.length; p++) {
      hunks.push({ id: id(), kind: "removed", before: dels[p], after: null });
    }
    for (let p = paired; p < ins.length; p++) {
      hunks.push({ id: id(), kind: "added", before: null, after: ins[p] });
    }
  }
  return hunks;
}

// ── Applying a review ───────────────────────────────────────────────────────

/**
 * The HTML a reviewer's decisions produce.
 *
 *   unchanged        always the original
 *   changed          accepted: the rewrite; otherwise the original
 *   added            accepted: the new block; otherwise nothing
 *   removed          accepted: gone; otherwise the original stays
 *   edited[id]       wins over all of the above: the reviewer's own text
 *
 * "Otherwise" includes "no decision recorded". That default is the guardrail:
 * pushing with nothing decided pushes the page as it was.
 */
export function applyDecisions(
  hunks: readonly Hunk[],
  decisions: Record<string, HunkDecision> = {},
  edited: Record<string, string> = {},
): string {
  const parts: string[] = [];
  for (const h of hunks) {
    if (typeof edited[h.id] === "string") {
      if (edited[h.id].trim()) parts.push(edited[h.id].trim());
      continue;
    }
    const accepted = decisions[h.id] === "accepted";
    switch (h.kind) {
      case "unchanged":
        parts.push(h.before ?? "");
        break;
      case "changed":
        parts.push(accepted ? h.after ?? "" : h.before ?? "");
        break;
      case "added":
        if (accepted) parts.push(h.after ?? "");
        break;
      case "removed":
        if (!accepted) parts.push(h.before ?? "");
        break;
    }
  }
  return parts.filter(Boolean).join("\n");
}

/** "N / M kept": how many reviewable hunks were accepted. */
export function summarizeDecisions(
  hunks: readonly Hunk[],
  decisions: Record<string, HunkDecision> = {},
  edited: Record<string, string> = {},
): { kept: number; total: number; undecided: number } {
  const reviewable = hunks.filter((h) => h.kind !== "unchanged");
  let kept = 0;
  let undecided = 0;
  for (const h of reviewable) {
    if (typeof edited[h.id] === "string" || decisions[h.id] === "accepted") kept++;
    else if (decisions[h.id] !== "rejected") undecided++;
  }
  return { kept, total: reviewable.length, undecided };
}

/** The stored `decisions` column, in the shape the UI writes, whatever is there. */
export function readDecisions(raw: unknown): ExecutionDecisions {
  const r = (raw ?? {}) as Partial<ExecutionDecisions>;
  return {
    decisions: (r.decisions && typeof r.decisions === "object" ? r.decisions : {}) as Record<string, HunkDecision>,
    edited: (r.edited && typeof r.edited === "object" ? r.edited : {}) as Record<string, string>,
    fields: (r.fields && typeof r.fields === "object" ? r.fields : {}) as ExecutionDecisions["fields"],
  };
}
