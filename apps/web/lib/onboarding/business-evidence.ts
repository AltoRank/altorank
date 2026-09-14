import { fetchSite } from "@/lib/audit/lenient-fetch";

const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

/** Keep catalog/navigation and service-area evidence separately from main copy. */
export function businessPageEvidence(html: string, url: string): { text: string; links: string[] } {
  const clean = html.replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const navigation = [...clean.matchAll(/<(nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi)].map(m => plain(m[0]));
  const main = clean.replace(/<(nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const links: string[] = [];
  for (const match of clean.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const target = new URL(match[1], url);
      if (target.origin !== new URL(url).origin || !/^https?:$/.test(target.protocol)) continue;
      if (!/pricing|features|services|products|collections|areas|locations/i.test(`${target.pathname} ${plain(match[2])}`)) continue;
      target.hash = ""; target.search = "";
      if (target.href !== url && !links.includes(target.href)) links.push(target.href);
    } catch { /* Ignore malformed links. */ }
  }
  // Spread the limited context over body and navigation; truncating the whole
  // page at the start used to lose service areas and plan-specific exceptions.
  const body = plain(main);
  const bodySample = body.length > 6000 ? `${body.slice(0, 4200)}\n[excerpt omitted]\n${body.slice(-1800)}` : body;
  return { text: `SOURCE ${url}\n${bodySample}\nCatalog and service navigation: ${[...new Set(navigation)].join(" ").slice(0, 2500)}`, links };
}

async function read(url: string): Promise<ReturnType<typeof businessPageEvidence> | null> {
  try {
    const response = await fetchSite(url, { homepageFallback:true, signal: AbortSignal.timeout(8000), headers: { "User-Agent": "AltoRankBot/1.0 (content analysis)" } });
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader(); const decoder = new TextDecoder();
    let html = ""; let bytes = 0;
    try {
      while (bytes < 1_000_000) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.length; html += decoder.decode(value, { stream: true });
      }
    } finally { await reader.cancel(); }
    return businessPageEvidence(html, response.url || url);
  } catch { return null; }
}

export async function readBusinessEvidence(domain: string, maxChars: number): Promise<string> {
  const base = new URL(domain.startsWith("http") ? domain : `https://${domain}`).href;
  const home = await read(base);
  if (!home) return "";
  // Use observed links rather than guessing /features for every kind of business.
  // Prefer one overview from each family before deeper individual products.
  const ordered = [...home.links].sort((a, b) => new URL(a).pathname.split("/").filter(Boolean).length - new URL(b).pathname.split("/").filter(Boolean).length);
  const selected: string[] = []; const families = new Set<string>();
  for (const url of ordered) {
    const family = new URL(url).pathname.split("/").filter(Boolean)[0];
    if (families.has(family)) continue;
    selected.push(url); families.add(family);
    if (selected.length === 3) break;
  }
  const pages = await Promise.all(selected.map(read));
  const perPage = Math.max(1500, Math.floor((maxChars - Math.min(home.text.length, 7500)) / Math.max(1, pages.filter(Boolean).length)));
  return [home.text.slice(0, 7500), ...pages.filter(p => p !== null).map(p => p.text.slice(0, perPage))].join("\n\n").slice(0, maxChars);
}
