import { fetchSite } from "@/lib/audit/lenient-fetch";
import { currentResearchBudget } from "@/lib/seo/request-context";
export interface PageExtract { url: string; resolvedUrl?: string; title: string; headings: string[]; text: string; links?: Array<{url:string;label:string}>; }
/** Public, bounded page read. Inaccessible content is unknown, never approval. */
export async function readPageExtract(url: string, maxChars = 4500, options: {includeLinks?:boolean} = {}): Promise<PageExtract | null> {
  try {
    const remaining = (currentResearchBudget()?.deadline ?? Date.now() + 6000) - Date.now();
    if (remaining <= 0) return null;
    const response = await fetchSite(url, { signal: AbortSignal.timeout(Math.min(6000, remaining)), headers: { "User-Agent": "AltoRankBot/1.0" } });
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader();
    let html = ""; const decoder = new TextDecoder(); let bytes = 0;
    try {
      while (bytes < 750_000) {
        const { value, done } = await reader.read(); if (done) break;
        bytes += value.length; html += decoder.decode(value, { stream: true });
      }
    } finally { await reader.cancel(); }
    const plain = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    const title = plain(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
    const headings = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].slice(0, 15).map((m) => plain(m[1]));
    const text = plain(html.replace(/<(script|style|nav|footer|header)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")).slice(0, maxChars);
    const links: Array<{url:string;label:string}> = [];
    const linkBody = html.replace(/<(script|style|nav|footer|header)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
    for (const match of options.includeLinks ? linkBody.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi) : []) {
      try {
        const target = new URL(match[1], response.url || url);
        if (!/^https?:$/.test(target.protocol) || target.username || target.password) continue;
        target.hash = "";
        if (/\/(?:login|signin|signup|sign-in|sign-up|privacy|terms|cart|checkout)(?:\/|$)/i.test(target.pathname)) continue;
        const label = plain(match[2]).slice(0, 100);
        if (label && !links.some(link => link.url === target.href)) links.push({url:target.href,label});
        if (links.length >= 80) break;
      } catch { /* Ignore malformed source links. */ }
    }
    return text.length >= 120 ? { url, ...(response.url ? {resolvedUrl:response.url} : {}), title, headings, text, ...(options.includeLinks?{links}:{}) } : null;
  } catch { return null; }
}
