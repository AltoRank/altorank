import { parseDocument } from "htmlparser2";
import { fetchSite } from "@/lib/audit/lenient-fetch";
import { currentResearchBudget } from "@/lib/seo/request-context";

export interface PageExtract {
  provenance?: "profile-quote" | "rendered";
  url: string;
  resolvedUrl?: string;
  title: string;
  headings: string[];
  text: string;
  links?: Array<{ url: string; label: string }>;
}

export interface PageReadDiagnostics {
  url: string;
  resolvedUrl?: string;
  httpStatus?: number;
  contentType?: string;
  bytesRead: number;
  /** A byte cap was reached; the rest of the response was not read. */
  bodyTruncated: boolean;
  excerptTruncated: boolean;
  /** Visible content length before applying the caller's excerpt limit. */
  extractedChars: number;
  strategy?: "main" | "article" | "body-minus-chrome" | "plain-text";
}

export type PageReadFailureReason =
  | "http-error" | "timeout" | "budget-exhausted" | "network-error" | "empty-body"
  | "unsupported-content-type" | "binary-document"
  | "navigation-only" | "short-extraction";

export type PageReadOutcome =
  | { status: "success"; page: PageExtract; diagnostics: PageReadDiagnostics }
  | {
    status: "unavailable" | "unsupported" | "insufficient";
    reason: PageReadFailureReason;
    diagnostics: PageReadDiagnostics;
    /** Short routing pages may supply observed links, but are not substantive evidence. */
    page?: PageExtract;
  };

type HtmlNode = ReturnType<typeof parseDocument>["children"][number];
type HtmlElement = Extract<HtmlNode, { attribs: unknown }>;
const isElement = (node: HtmlNode): node is HtmlElement => "attribs" in node;
const NON_CONTENT = new Set(["head", "script", "style", "svg", "noscript", "iframe", "template", "form", "dialog", "select", "button", "input", "source", "track"]);
const CHROME_TAGS = new Set(["nav", "header", "footer", "aside"]);
const CHROME_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary", "search", "dialog"]);
const CHROME_CLASS = /\b(?:cookie|consent|gdpr|banner|navbar|nav-|menu|sidebar|breadcrumb|skip-link|social-share|newsletter|popup|modal|offcanvas|site-header|site-footer)\b/i;
const BLOCKS = new Set(["main", "article", "body", "p", "div", "section", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "table", "header", "footer", "aside", "figure", "figcaption", "details", "summary", "dl", "dt", "dd", "blockquote", "pre", "ul", "ol"]);

function hidden(node: HtmlElement): boolean {
  return "hidden" in node.attribs || node.attribs["aria-hidden"]?.toLowerCase() === "true"
    || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important)?\s*(?:;|$)/i.test(node.attribs.style ?? "");
}

function chrome(node: HtmlElement): boolean {
  return CHROME_TAGS.has(node.name) || CHROME_ROLES.has(node.attribs.role?.toLowerCase())
    || "data-print-hide" in node.attribs
    // Body-level classes describe the page's layout, including its navigation.
    // They cannot establish that every descendant is navigation or a sidebar.
    || (!["html","body"].includes(node.name) && CHROME_CLASS.test(`${node.attribs.class ?? ""} ${node.attribs.id ?? ""}`));
}

/** Iterative traversal also handles deeply nested, untrusted documents. */
function* elements(nodes: HtmlNode[], excludeChrome: boolean, includeHead = false): Generator<HtmlElement> {
  const pending = [...nodes].reverse();
  while (pending.length) {
    const node = pending.pop()!;
    if (!isElement(node)) continue;
    if ((NON_CONTENT.has(node.name) && !(includeHead && node.name === "head")) || hidden(node) || (excludeChrome && chrome(node))) continue;
    yield node;
    for (let i = node.children.length - 1; i >= 0; i--) pending.push(node.children[i]);
  }
}

/**
 * Tokenize complete markup before segmenting visible text. Attributes, including
 * multiline JavaScript with quoted `>` characters, never become text nodes.
 * Keep table cells on one row and pricing cards/paragraphs on separate lines.
 */
function visibleText(nodes: HtmlNode[], excludeChrome = true): string {
  const out: string[] = [];
  const pending = nodes.map(node => ({ node, exit: false, inCell: false })).reverse();
  while (pending.length) {
    const { node, exit, inCell } = pending.pop()!;
    if (node.type === "text") { out.push(node.data.replace(/\s+/g, " ")); continue; }
    if (!isElement(node) || NON_CONTENT.has(node.name) || hidden(node) || (excludeChrome && chrome(node))) continue;
    const cell = node.name === "td" || node.name === "th";
    if (exit) { if (BLOCKS.has(node.name)) out.push(inCell ? " " : "\n"); continue; }
    if (cell) out.push(" | ");
    else if ((BLOCKS.has(node.name) || node.name === "br") && !inCell) out.push("\n");
    else if (node.name === "br" || (BLOCKS.has(node.name) && inCell)) out.push(" ");
    pending.push({ node, exit: true, inCell });
    for (let i = node.children.length - 1; i >= 0; i--) pending.push({ node: node.children[i], exit: false, inCell: inCell || cell });
  }
  return out.join("").split("\n").map(line => line.replace(/[^\S\n]+/g, " ").replace(/^\s*\|\s*/, "").trim()).filter(Boolean).join("\n");
}

function contentRoot(nodes: HtmlNode[]): { nodes: HtmlNode[]; strategy: Exclude<PageReadDiagnostics["strategy"], undefined | "plain-text"> } {
  let main: HtmlElement | undefined;
  let article: HtmlElement | undefined;
  let mainLength = -1;
  let articleLength = -1;
  let body: HtmlElement | undefined;
  for (const node of elements(nodes, true)) {
    if (node.name === "body") body ??= node;
    if (node.name === "main" || node.name === "article") {
      const length = visibleText(node.children).length;
      if (node.name === "main" && length > mainLength) { main = node; mainLength = length; }
      if (node.name === "article" && length > articleLength) { article = node; articleLength = length; }
    }
  }
  if (main) return { nodes: main.children, strategy: "main" };
  if (article) return { nodes: article.children, strategy: "article" };
  return { nodes: body?.children ?? nodes, strategy: "body-minus-chrome" };
}

function observedLinks(main: HtmlNode[], document: HtmlNode[], baseUrl: string): Array<{ url: string; label: string }> {
  const links = new Map<string, { url: string; label: string }>();
  const mainUrls = new Set<string>();
  let scanned = 0;
  for (const [index, nodes] of [main, document].entries()) {
    for (const node of elements(nodes, false)) {
      if (node.name !== "a" || !node.attribs.href) continue;
      if (++scanned > 2500) break;
      try {
        const target = new URL(node.attribs.href, baseUrl);
        if (target.href.length > 2048 || !/^https?:$/.test(target.protocol) || target.username || target.password) continue;
        target.hash = "";
        if (/\/(?:login|signin|signup|sign-in|sign-up|privacy|terms|cart|checkout)(?:\/|$)/i.test(target.pathname)) continue;
        const label = visibleText(node.children, false).replace(/\s+/g, " ").slice(0, 100);
        if (!label) continue;
        if (index === 0) mainUrls.add(target.href);
        if (!links.has(target.href)) links.set(target.href, { url: target.href, label });
      } catch { /* Ignore malformed source links. */ }
    }
    if (scanned >= 2500) break;
  }
  // Prefer observed pricing/help and article references over large product menus.
  const priority = (link: { url: string; label: string }) => /pricing|plans|prezzi|tarifs|preise|precios|help|support|care|instructions|manual|docs/i.test(`${link.label} ${new URL(link.url).pathname}`) ? 2 : mainUrls.has(link.url) ? 1 : 0;
  return [...links.values()].sort((a, b) => priority(b) - priority(a)).slice(0, 80);
}

/** Public, bounded page read with causes retained for evidence recovery. */
export async function readPageExtractOutcome(url: string, maxChars = 4500, options: { includeLinks?: boolean } = {}): Promise<PageReadOutcome> {
  const diagnostics: PageReadDiagnostics = { url, bytesRead: 0, bodyTruncated: false, excerptTruncated: false, extractedChars: 0 };
  let signal: AbortSignal | undefined;
  try {
    const remaining = (currentResearchBudget()?.deadline ?? Date.now() + 6000) - Date.now();
    if (remaining <= 0) return { status: "unavailable", reason: "budget-exhausted", diagnostics };
    signal = AbortSignal.timeout(Math.min(6000, remaining));
    const response = await fetchSite(url, { homepageFallback: true, signal, headers: { "User-Agent": "AltoRankBot/1.0" } });
    diagnostics.httpStatus = response.status;
    if (response.url) diagnostics.resolvedUrl = response.url;
    const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (contentType) diagnostics.contentType = contentType;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { status: "unavailable", reason: "http-error", diagnostics };
    }
    if (!response.body) return { status: "unavailable", reason: "empty-body", diagnostics };
    if (contentType && !["text/html", "application/xhtml+xml", "text/plain"].includes(contentType)) {
      await response.body.cancel().catch(() => undefined);
      return { status: "unsupported", reason: "unsupported-content-type", diagnostics };
    }
    const reader = response.body.getReader();
    let html = "";
    const decoder = new TextDecoder();
    try {
      while (diagnostics.bytesRead < 2_000_000) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = value.subarray(0, 2_000_000 - diagnostics.bytesRead);
        diagnostics.bytesRead += chunk.length;
        html += decoder.decode(chunk, { stream: true });
        if (diagnostics.bytesRead === 2_000_000) diagnostics.bodyTruncated = true;
      }
      html += decoder.decode();
    } finally { await reader.cancel().catch(() => undefined); }
    if (!html.trim()) return { status: "unavailable", reason: "empty-body", diagnostics };
    if (html.trimStart().startsWith("%PDF-") || html.includes("\0")) return { status: "unsupported", reason: "binary-document", diagnostics };

    // Some HTML endpoints omit a MIME type (and Response fixtures default to
    // text/plain). Actual plain documents keep comparisons such as `x < 10`.
    const markup = /<(?:!doctype\s+html|html|head|body|main|article|section|div|p|nav|h[1-6]|table)\b/i.test(html);
    let title = "";
    const headings: string[] = [];
    let text: string;
    let links: Array<{ url: string; label: string }> = [];
    let hasNavigation = false;
    if (contentType === "text/plain" && !markup) {
      diagnostics.strategy = "plain-text";
      text = html.split(/\r?\n/).map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
    } else {
      // Marketing tag-manager snippets sometimes self-close an iframe inside
      // noscript. Otherwise its raw-text state can swallow the real body.
      const document = parseDocument(html, { decodeEntities: true, recognizeSelfClosing: true });
      const root = contentRoot(document.children);
      diagnostics.strategy = root.strategy;
      text = visibleText(root.nodes);
      for (const node of elements(document.children, false, true)) {
        if (node.name === "title" && !title) title = visibleText(node.children, false);
        if (CHROME_TAGS.has(node.name) || CHROME_ROLES.has(node.attribs.role?.toLowerCase())) hasNavigation = true;
      }
      for (const node of elements(root.nodes, true)) {
        if (/^h[1-3]$/.test(node.name) && headings.length < 15) headings.push(visibleText(node.children));
      }
      if (options.includeLinks) links = observedLinks(root.nodes, document.children, response.url || url);
    }
    diagnostics.extractedChars = text.length;
    const excerptLimit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 4500;
    diagnostics.excerptTruncated = text.length > excerptLimit;
    const page: PageExtract = { url, ...(response.url ? { resolvedUrl: response.url } : {}), title, headings, text: text.slice(0, excerptLimit), ...(options.includeLinks ? { links } : {}) };
    if (text.length < 120) return { status: "insufficient", reason: !text && hasNavigation ? "navigation-only" : "short-extraction", page, diagnostics };
    return { status: "success", page, diagnostics };
  } catch (error) {
    const timeout = signal?.aborted || (error instanceof Error && /^(?:TimeoutError|AbortError)$/.test(error.name));
    return { status: "unavailable", reason: timeout ? "timeout" : "network-error", diagnostics };
  }
}

/** Compatibility wrapper: inaccessible or insufficient content stays unknown. */
export async function readPageExtract(url: string, maxChars = 4500, options: { includeLinks?: boolean } = {}): Promise<PageExtract | null> {
  const result = await readPageExtractOutcome(url, maxChars, options);
  return result.status === "success" ? result.page : null;
}
