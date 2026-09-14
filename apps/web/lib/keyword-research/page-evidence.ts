import { fetchSite } from "@/lib/audit/lenient-fetch";
import { currentResearchBudget } from "@/lib/seo/request-context";
import { extractMainContent } from "@/lib/audit/markdown";
import { stripTags } from "@/lib/audit/html-utils";
export interface PageExtract { provenance?: "profile-quote" | "rendered"; url: string; resolvedUrl?: string; title: string; headings: string[]; text: string; links?: Array<{url:string;label:string}>; }
/** Public, bounded page read. Inaccessible content is unknown, never approval. */
export async function readPageExtract(url: string, maxChars = 4500, options: {includeLinks?:boolean} = {}): Promise<PageExtract | null> {
  try {
    const remaining = (currentResearchBudget()?.deadline ?? Date.now() + 6000) - Date.now();
    if (remaining <= 0) return null;
    const response = await fetchSite(url, { homepageFallback:true, signal: AbortSignal.timeout(Math.min(6000, remaining)), headers: { "User-Agent": "AltoRankBot/1.0" } });
    if (!response.ok || !response.body) return null;
    const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (contentType && !["text/html", "application/xhtml+xml", "text/plain"].includes(contentType)) {
      await response.body.cancel();
      return null;
    }
    const reader = response.body.getReader();
    let html = ""; const decoder = new TextDecoder(); let bytes = 0;
    try {
      while (bytes < 2_000_000) {
        const { value, done } = await reader.read(); if (done) break;
        const chunk = value.subarray(0, 2_000_000 - bytes);
        bytes += chunk.length; html += decoder.decode(chunk, { stream: true });
      }
    } finally { await reader.cancel(); }
    if (html.startsWith("%PDF-")) return null;
    const plain = stripTags;
    const title = plain(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
    const headings = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].slice(0, 15).map((m) => plain(m[1]));
    const mainHtml = extractMainContent(html).html;
    // Keep block boundaries: adjacent pricing cards must not become one sentence.
    const text = mainHtml.replace(/<\/(?:p|div|section|li|h[1-6]|tr)>|<br\s*\/?>/gi, "\n")
      .split(/\n+/).map(plain).filter(Boolean).join("\n").slice(0, maxChars);
    const links: Array<{url:string;label:string}> = [];
    const mainUrls = new Set<string>();
    const linkBodies = [mainHtml, html].map(body => body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " "));
    let scanned = 0;
    for (const [bodyIndex, linkBody] of (options.includeLinks ? linkBodies : []).entries()) {
      if (scanned >= 2500) break;
      for (const match of linkBody.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
        if (++scanned > 2500) break;
        try {
          const target = new URL(match[1], response.url || url);
          if (target.href.length > 2048 || !/^https?:$/.test(target.protocol) || target.username || target.password) continue;
          target.hash = "";
          if (/\/(?:login|signin|signup|sign-in|sign-up|privacy|terms|cart|checkout)(?:\/|$)/i.test(target.pathname)) continue;
          const label = plain(match[2]).slice(0, 100);
          if (label && bodyIndex === 0) mainUrls.add(target.href);
          if (label && !links.some(link => link.url === target.href)) links.push({url:target.href,label});
          if (scanned >= 2500) break;
        } catch { /* Ignore malformed source links. */ }
      }
    }
    // Read article links before navigation so observed vendor references are
    // not displaced by large menus. Pricing still gets first priority.
    // Large product menus can put pricing beyond the first 80 links. Keep
    // observed pricing references before trimming the bounded candidate list.
    const priority = (link: {url:string;label:string}) => /pricing|plans|prezzi|tarifs|preise|precios|help|support|care|instructions|manual|docs/i.test(`${link.label} ${new URL(link.url).pathname}`) ? 2 : mainUrls.has(link.url) ? 1 : 0;
    const selectedLinks = links.sort((a,b)=>priority(b)-priority(a)).slice(0,80);
    return text.length >= 120 ? { url, ...(response.url ? {resolvedUrl:response.url} : {}), title, headings, text, ...(options.includeLinks?{links:selectedLinks}:{}) } : null;
  } catch { return null; }
}
