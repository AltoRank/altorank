import { fetchSite } from "@/lib/audit/lenient-fetch";
import { currentResearchBudget } from "@/lib/seo/request-context";
export interface PageExtract { url: string; title: string; headings: string[]; text: string; }
/** Public, bounded page read. Inaccessible content is unknown, never approval. */
export async function readPageExtract(url: string): Promise<PageExtract | null> {
  try {
    const remaining = (currentResearchBudget()?.deadline ?? Date.now() + 6000) - Date.now();
    if (remaining <= 0) return null;
    const response = await fetchSite(url, { signal: AbortSignal.timeout(Math.min(6000, remaining)), headers: { "User-Agent": "AltoRankBot/1.0" } });
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader();
    let html = ""; const decoder = new TextDecoder(); let bytes = 0;
    try {
      while (bytes < 160_000) {
        const { value, done } = await reader.read(); if (done) break;
        bytes += value.length; html += decoder.decode(value, { stream: true });
      }
    } finally { await reader.cancel(); }
    const plain = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    const title = plain(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
    const headings = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].slice(0, 15).map((m) => plain(m[1]));
    const text = plain(html.replace(/<(script|style|nav|footer|header)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")).slice(0, 4500);
    return text.length >= 120 ? { url, title, headings, text } : null;
  } catch { return null; }
}
