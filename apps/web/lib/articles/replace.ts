// ---------------------------------------------------------------------------
// Find and replace inside an article, as a proposal first
// ---------------------------------------------------------------------------
//
// The article body is Tiptap JSON; the text lives in `text` nodes and nothing
// else. Replacing walks those nodes and the title, leaves every other node
// (images, links, marks, tables) exactly as it found it, and reports each hit
// with the sentence around it so a person - or the agent on their behalf - can
// see what would change before anything does.
//
// A match never crosses a node boundary. "AltoRank" split across a bold and a
// plain node is two nodes and no match, which is the conservative failure: a
// replace that silently rewrote text across formatting would be worse than
// one that reports zero and lets a human do it in the editor.
//
// Pure functions. No Supabase, no Next.

export type TiptapNode = {
  type: string;
  content?: TiptapNode[];
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
};

export type ReplaceOptions = {
  find: string;
  replace: string;
  /** Default false: "altorank" matches "AltoRank". */
  match_case?: boolean;
  /** Default false: "rank" matches "AltoRank". True requires word boundaries. */
  whole_word?: boolean;
};

export type ReplaceHit = {
  /** "title" or "body". */
  where: "title" | "body";
  /** The text around the match, before the change, with the match marked by « ». */
  before: string;
  /** The same text after the change. */
  after: string;
};

export type ReplacePlan = {
  find: string;
  replace: string;
  /** Total occurrences across title and body. */
  occurrences: number;
  hits: ReplaceHit[];
  /** The body after replacement. Unchanged object when occurrences is 0. */
  content: TiptapNode | null;
  /** The title after replacement. */
  title: string;
  /** Words in the new body, counted the way the editor counts them. */
  word_count: number;
};

const EXCERPT_RADIUS = 60;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildMatcher(opts: ReplaceOptions): RegExp {
  const core = escapeRegExp(opts.find);
  // Word boundaries via lookarounds so a find that starts or ends in
  // punctuation ("C++") still works; \b would refuse it.
  const body = opts.whole_word ? `(?<![\\p{L}\\p{N}_])${core}(?![\\p{L}\\p{N}_])` : core;
  return new RegExp(body, `gu${opts.match_case ? "" : "i"}`);
}

function excerpt(text: string, start: number, end: number, replacement: string): { before: string; after: string } {
  const from = Math.max(0, start - EXCERPT_RADIUS);
  const to = Math.min(text.length, end + EXCERPT_RADIUS);
  const lead = (from > 0 ? "…" : "") + text.slice(from, start);
  const tail = text.slice(end, to) + (to < text.length ? "…" : "");
  return {
    before: `${lead}«${text.slice(start, end)}»${tail}`,
    after: `${lead}«${replacement}»${tail}`,
  };
}

/** Replace in one string, collecting a hit per match. */
function replaceInText(text: string, matcher: RegExp, replacement: string, where: ReplaceHit["where"], hits: ReplaceHit[]): string {
  matcher.lastIndex = 0;
  let out = "";
  let last = 0;
  for (const m of text.matchAll(matcher)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (m[0].length === 0) continue;
    hits.push({ where, ...excerpt(text, start, end, replacement) });
    out += text.slice(last, start) + replacement;
    last = end;
  }
  return out + text.slice(last);
}

function replaceInNode(node: TiptapNode, matcher: RegExp, replacement: string, hits: ReplaceHit[]): TiptapNode {
  if (node.type === "text" && typeof node.text === "string") {
    const next = replaceInText(node.text, matcher, replacement, "body", hits);
    return next === node.text ? node : { ...node, text: next };
  }
  if (!node.content) return node;
  let changed = false;
  const content = node.content.map((child) => {
    const next = replaceInNode(child, matcher, replacement, hits);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...node, content } : node;
}

/** The editor's own count: whitespace-separated runs of the document text. */
export function countWords(node: TiptapNode | null): number {
  if (!node) return 0;
  const parts: string[] = [];
  const walk = (n: TiptapNode) => {
    if (n.type === "text" && n.text) parts.push(n.text);
    n.content?.forEach(walk);
  };
  walk(node);
  return parts.join(" ").split(/\s+/).filter(Boolean).length;
}

/**
 * What replacing `find` with `replace` would do to this article. Nothing is
 * written; the caller decides whether to keep `content` and `title`.
 */
export function planReplace(
  article: { title: string; content: unknown },
  opts: ReplaceOptions,
): ReplacePlan {
  if (!opts.find) throw new Error("find must not be empty.");
  const matcher = buildMatcher(opts);
  const hits: ReplaceHit[] = [];

  const title = replaceInText(article.title ?? "", matcher, opts.replace, "title", hits);

  const body = (article.content && typeof article.content === "object" ? (article.content as TiptapNode) : null);
  const content = body ? replaceInNode(body, matcher, opts.replace, hits) : null;

  return {
    find: opts.find,
    replace: opts.replace,
    occurrences: hits.length,
    hits,
    content,
    title,
    word_count: countWords(content),
  };
}
