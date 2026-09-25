/**
 * No new English inside the language-dependent code, outside the contract.
 *
 * The first Turkish draft (a real signup, 2026-09-22) was not failed by one
 * module but by eleven, each of which had its own English label or English
 * regex and fell back to it silently. lib/i18n/locale.ts is now the one place
 * a language is described. This walks lib/content, lib/seo, lib/ai and
 * lib/publishing and fails when one of them grows its own again, in three
 * ways:
 *
 *   1. LABELS: English text a string writes into an article. Three shapes,
 *      because the incident's labels were none of the first one:
 *        - an HTML element with literal Latin text in it
 *          (`<h2>Frequently asked questions</h2>`, `aria-label="Bar chart`,
 *          `alt="Sketch`);
 *        - a literal that IS a known English label, alone or after an opening
 *          tag: the values of a label map ("Contents", `Learn more about
 *          ${name}`, "Sketch illustrating"), a chart's `Bar chart: ${d}`,
 *          `<small>Powered by`. Every one of those passed the element rule,
 *          because they were interpolated into markup somewhere else;
 *        - a Tiptap text node with literal Latin text (`{ type: "text", text:
 *          " Learn more about " }`), which is how the backlink exchange wrote
 *          English into drafts without any markup at all.
 *      Text written into an article belongs in `ArticleLabels`.
 *
 *   2. MARKERS: a regex (literal or `new RegExp` argument) that spells an
 *      English word the language-dependent checks key on - "according to",
 *      "percent", "studies", "key takeaways", "how to", "we tested"... That
 *      word belongs in `ProseRules`, `NumberRules` or `HeadingRules`.
 *
 *   3. CALLERS: a production call to a language-dependent entry point
 *      (`scoreArticle`, `scoreCitationReadiness`, `auditArticle`,
 *      `factCheckArticle`, `enrichArticle`) that does not pass a language.
 *      The contract's default is English, which is right for tests and the
 *      reason the Turkish draft was scored as English.
 *
 * It reads the TypeScript AST, not text, so comments and prose are never
 * matched: only string, template and regex literals are looked at. Adding to
 * an allowlist is a normal thing to do when the English is not language
 * rules for article text (a keyword classifier, a UI note). Write the reason.
 * An entry that stops matching fails the test, so the list cannot rot.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(__dirname, "..", "..", "..");
const SCOPE = ["lib/content", "lib/seo", "lib/ai", "lib/publishing"];

// ── What counts ────────────────────────────────────────────────────────────

/** English words that only matter as markers of a language-dependent check. */
const ENGLISH_MARKERS: { name: string; pattern: RegExp }[] = [
  { name: "attribution", pattern: /according to|reported by|published by|study by|research by|data from/i },
  { name: "percent word", pattern: /\bper ?cent\b|\bpercent/i },
  { name: "scale word", pattern: /\b(?:million|billion|thousand)\b/i },
  { name: "evidence appeal", pattern: /\bstud(?:y|ies)\b|\bexperts?\b|well[- ]known/i },
  { name: "summary label", pattern: /takeaways?|tl;\??\s?dr|in short|at a glance|final thoughts|conclusion/i },
  { name: "faq label", pattern: /frequently asked/i },
  { name: "how-to heading", pattern: /how to\b|step[- ]by[- ]step|getting started|walkthrough/i },
  { name: "byline", pattern: /written by|about the author/i },
  { name: "first-hand", pattern: /we tested|we tried|in our experience/i },
  { name: "generic anchor", pattern: /click here|read more|learn more/i },
  { name: "sources footer", pattern: /further reading|bibliography|works cited/i },
  { name: "definition verb", pattern: /refers to|\(is\|are/i },
  { name: "announcement", pattern: /in this (?:\(|section|article)|let'\?s/i },
  { name: "pronoun", pattern: /\(we\|our|\bdon't\b|\bwon't\b/i },
  { name: "multiplier", pattern: /times\\s\+?\(\?:more|times\s+more/i },
  { name: "superlative", pattern: /number one|market leader|industry[- ]leading|fastest[- ]growing/i },
  { name: "image wrapper", pattern: /\(\?:image\|picture|screenshot\|/i },
];

/**
 * Label-writing elements whose literal text would be English in the article.
 * Two letters at least: `<a${attrs}>x</a>` is a probe the link checkers
 * build to parse one anchor, not text anyone reads.
 */
const LABEL_ELEMENT = /<(h[1-6]|figcaption|caption|summary|th|strong|b|a)\b[^>]*>\s*[A-Za-z]{2}[^<$]*<\/\1>/;
const LABEL_ATTRIBUTE = /\b(?:aria-label|alt|title)="[A-Za-z]/;

/**
 * A literal that is an English label the product has written into articles,
 * alone or after an opening tag. Anchored at the start and case-sensitive:
 * a label is a capitalised phrase standing alone ("Contents"), where a
 * sentence in a reviewer's UI that mentions "a table of contents", or a
 * lowercase list of phrases to RECOGNISE ("frequently asked questions" in the
 * topical profile), is not one. Each alternative is a string the product
 * wrote into a non-English article before the contract.
 */
const ENGLISH_LABEL =
  /^\s*(?:<[a-z][^>]*>\s*)*(?:Contents$|Table of contents$|Learn more\b|Read more\b|This article is published by\b|Visit\b|Sketch illustrating|Watercolou?r illustration|Photo-style image|Graphic illustrating|Illustration of\b|Bar chart\b|Figures from the text|Key takeaways$|Frequently asked questions$|Powered by\b|this resource$)/;

/** Latin letters in a Tiptap text node's literal: words written into the document. */
const TIPTAP_WORDS = /[A-Za-z]{2}/;

/** Entry points that read language, and must be told which. */
const LANGUAGE_ENTRY_POINTS = new Set(["scoreArticle", "scoreCitationReadiness", "auditArticle", "factCheckArticle", "enrichArticle"]);

// ── Allowlists ─────────────────────────────────────────────────────────────
//
// Key: `path:rule`, where rule is a marker name, `label:<the element>`, or the
// entry point called. Value: why that English is not an article-language rule. Legitimate
// entries are English that is about something other than the article's text:
// a classifier for search keywords, a UI string, an instruction to the model
// that shows syntax. Empty is the goal; at the time of writing every
// article-text regex in scope reads the contract.

const ALLOWED_MARKERS: Record<string, string> = {};

const ALLOWED_LABELS: Record<string, string> = {
  'lib/ai/prompts.ts:label:<a href="{{internal-link:KEYWORD}}">anchor</a>':
    'shows the model the internal-link placeholder syntax (<a href="{{internal-link:KEYWORD}}">anchor</a>); ' +
    '"anchor" stands for the article\'s own words and never reaches the page',
  "lib/seo/article-audit.ts:label:Table of contents":
    "the audit item's own name in the reviewer's panel, which is English UI; it is never written into the article",
};

const ALLOWED_CALLERS: Record<string, string> = {};

// ── Walk ───────────────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

type Finding = { key: string; file: string; line: number; text: string };

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

/** The literal text of a string or template, interpolations dropped. */
function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join("\u0000");
  }
  return null;
}

function isRegExpConstruction(node: ts.Node): node is ts.NewExpression | ts.CallExpression {
  return (
    (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "RegExp"
  );
}

type Findings = { markers: Finding[]; labels: Finding[]; callers: Finding[] };

/** Rule 1 on one literal: the element, the attribute, or the whole literal as a label. */
function labelIn(text: string): string | null {
  const m = text.match(LABEL_ELEMENT) ?? text.match(LABEL_ATTRIBUTE) ?? text.match(ENGLISH_LABEL);
  return m ? m[0].trim() : null;
}

/** A property's literal value in an object literal, by name. */
function literalProperty(node: ts.ObjectLiteralExpression, name: string, source: ts.SourceFile): string | null {
  for (const p of node.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText(source).replace(/["']/g, "") === name) return literalText(p.initializer);
  }
  return null;
}

/** Every finding in one file. `inScope` turns on rules 1 and 2; rule 3 runs everywhere. */
function scanFile(rel: string, source: ts.SourceFile, inScope: boolean, out: Findings): void {
  const visit = (node: ts.Node) => {
    if (inScope) {
      // Rule 2: regex literals and RegExp arguments.
      const regexTexts: string[] = [];
      if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) regexTexts.push((node as ts.RegularExpressionLiteral).text);
      if (isRegExpConstruction(node)) {
        for (const arg of node.arguments ?? []) {
          const t = literalText(arg);
          if (t) regexTexts.push(t);
          // String.raw`...`
          if (ts.isTaggedTemplateExpression(arg)) {
            const inner = literalText(arg.template);
            if (inner) regexTexts.push(inner);
          }
        }
      }
      for (const text of regexTexts) {
        for (const m of ENGLISH_MARKERS) {
          if (m.pattern.test(text)) {
            out.markers.push({ key: `${rel}:${m.name}`, file: rel, line: lineOf(source, node), text: text.slice(0, 80) });
          }
        }
      }

      // Rule 1: labels. Keyed by the label itself, so allowing one label in
      // a file does not allow the next.
      const text = literalText(node);
      const label = text ? labelIn(text) : null;
      if (text && label) {
        out.labels.push({ key: `${rel}:label:${label}`, file: rel, line: lineOf(source, node), text: text.slice(0, 80) });
      }
      if (ts.isObjectLiteralExpression(node) && literalProperty(node, "type", source) === "text") {
        const written = literalProperty(node, "text", source);
        if (written !== null && TIPTAP_WORDS.test(written)) {
          out.labels.push({ key: `${rel}:tiptap:${written.trim()}`, file: rel, line: lineOf(source, node), text: written.slice(0, 80) });
        }
      }
    }

    // Rule 3: production callers of language-dependent entry points.
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      if (name && LANGUAGE_ENTRY_POINTS.has(name)) {
        const args = node.arguments.map((a) => a.getText(source)).join(" ");
        if (!/\blanguage\b/i.test(args)) {
          out.callers.push({ key: `${rel}:${name}`, file: rel, line: lineOf(source, node), text: node.getText(source).slice(0, 80) });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function parse(file: string, src: string): ts.SourceFile {
  return ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function scan(): Findings {
  const out: Findings = { markers: [], labels: [], callers: [] };
  const files = [
    ...SCOPE.flatMap((d) => walk(join(ROOT, d))),
    // Callers live everywhere; the other two rules stay in SCOPE.
    ...["app", "components", "lib"].flatMap((d) => walk(join(ROOT, d))),
  ];
  for (const file of [...new Set(files)]) {
    const rel = relative(ROOT, file);
    // The contract itself is where every language's words are meant to be.
    if (rel === "lib/i18n/locale.ts") continue;
    const inScope = SCOPE.some((d) => rel.startsWith(`${d}/`));
    scanFile(rel, parse(file, readFileSync(file, "utf8")), inScope, out);
  }
  // A function declaration named like an entry point is not a call.
  return out;
}

const { markers, labels, callers } = scan();

function report(found: Finding[], allowed: Record<string, string>, why: string): void {
  const unexplained = found.filter((f) => !(f.key in allowed));
  const detail = unexplained.map((f) => `  ${f.file}:${f.line}  ${f.key.slice(f.file.length + 1)}  ${JSON.stringify(f.text)}`).join("\n");
  expect(unexplained.length, unexplained.length ? `\n${detail}\n\n${why}\n` : "").toBe(0);
}

function reportStale(found: Finding[], allowed: Record<string, string>): void {
  const live = new Set(found.map((f) => f.key));
  const stale = Object.keys(allowed).filter((k) => !live.has(k));
  expect(
    stale.length,
    stale.length ? `\nThese allowlist entries no longer match anything:\n${stale.map((s) => `  ${s}`).join("\n")}\n\nDelete them.\n` : "",
  ).toBe(0);
}

describe("the locale contract is the only place a language is described", () => {
  it("no English marker words in a regex under lib/content, lib/seo or lib/ai", () => {
    report(
      markers,
      ALLOWED_MARKERS,
      "A regex that keys on an English word reads every other language with English\n" +
        "rules, which is how a Turkish draft was scored, fact-checked and audited as\n" +
        "English on 2026-09-22. Put the words in lib/i18n/locale.ts (ProseRules,\n" +
        "NumberRules or HeadingRules) for every supported language and read them\n" +
        "through resolveLocale(). If this regex is not about article text, add it to\n" +
        "ALLOWED_MARKERS in this file with the reason.",
    );
  });

  it("no literal English labels written as HTML under lib/content, lib/seo or lib/ai", () => {
    report(
      labels,
      ALLOWED_LABELS,
      "Text written into an article comes from ArticleLabels in lib/i18n/locale.ts, in\n" +
        "the article's language; a language the contract does not describe gets the\n" +
        "element omitted, never English. \"Contents\" and \"Learn more about…\" were\n" +
        "written into a Turkish article this way.",
    );
  });

  it("every production caller of a language-dependent entry point passes a language", () => {
    report(
      callers,
      ALLOWED_CALLERS,
      "scoreArticle, scoreCitationReadiness, auditArticle, factCheckArticle and\n" +
        "enrichArticle read text with the language's rules and default to English when\n" +
        "not told. Pass `language` (workspaces.language) at the call.",
    );
  });

  it("every allowance still corresponds to real code", () => {
    reportStale(markers, ALLOWED_MARKERS);
    reportStale(labels, ALLOWED_LABELS);
    reportStale(callers, ALLOWED_CALLERS);
  });

  it("actually finds what it is looking for", () => {
    // A guard that matches nothing passes forever. These are the shapes the
    // rules exist for; if the walker breaks, this fails.
    const found: Findings = { markers: [], labels: [], callers: [] };
    scanFile(
      "lib/content/probe.ts",
      parse(
        "probe.ts",
        'const a = /according to (\\w+)/; const b = `<h2>Frequently asked questions</h2>`; scoreArticle(html, kw, { siteDomain });',
      ),
      true,
      found,
    );
    expect([found.markers.length > 0, found.labels.length > 0, found.callers.length > 0]).toEqual([true, true, true]);
  });

  it("would have failed on the English the incident's article was given", () => {
    // The shapes that wrote English into the Turkish draft, as they stood on
    // main before the contract: the enrichment's label map, the chart's
    // aria-label, the backlink exchange's Tiptap sentence and the free-tier
    // attribution line. None of them is an element with text inside it, so
    // the first version of rule 1 passed every one.
    const before = [
      "const EN: Labels = {",
      '  contents: "Contents",',
      '  figuresFrom: "Figures from the text:",',
      "  learnMore: (name) => `Learn more about ${name}`,",
      "  publishedBy: (name) => `This article is published by ${name}.`,",
      '  visit: "Visit",',
      '  illustration: { sketch: "Sketch illustrating", watercolor: "Watercolour illustration of", illustration: "Illustration of" },',
      "};",
      "const aria = `aria-label=\"${escapeAttr(`Bar chart: ${description}`)}\"`;",
      'const linkNodes = [{ type: "text", text: " Learn more about " }, link, { type: "text", text: "." }];',
      "const line = `<small>Powered by <a href=\"${ATTRIBUTION_URL}\">${ATTRIBUTION_ANCHOR}</a></small>`;",
    ].join("\n");
    const found: Findings = { markers: [], labels: [], callers: [] };
    scanFile("lib/content/enrich/labels.ts", parse("labels.ts", before), true, found);
    const keys = found.labels.map((f) => f.key.replace("lib/content/enrich/labels.ts:", ""));
    expect(keys).toEqual(
      expect.arrayContaining([
        "label:Contents",
        "label:Figures from the text",
        "label:Learn more",
        "label:This article is published by",
        "label:Visit",
        "label:Sketch illustrating",
        "label:Watercolour illustration",
        "label:Illustration of",
        "label:Bar chart",
        "tiptap:Learn more about",
        "label:<small>Powered by",
      ]),
    );
    // The same file written the contract's way has nothing to find.
    const after = [
      "const labels = locale.labels;",
      "const aria = `aria-label=\"${escapeAttr(labels.barChart(description))}\"`;",
      'const nodes = [{ type: "text", text: ` ${before}` }, link, { type: "text", text: " (" }];',
      "const recognised = new Set([\"frequently asked questions\", \"learn more\"]);",
      'const ui = "12 sections and no table of contents.";',
    ].join("\n");
    const clean: Findings = { markers: [], labels: [], callers: [] };
    scanFile("lib/content/enrich/labels.ts", parse("labels.ts", after), true, clean);
    expect(clean.labels).toEqual([]);
  });
});
