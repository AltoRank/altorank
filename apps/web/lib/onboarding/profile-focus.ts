export interface ProductCapability {
  claim: string;
  sourceUrl: string;
  quote: string;
  status: "observed" | "inferred" | "confirmed";
}
export interface BusinessFocus {
  primaryBuyer?: string | null;
  priorityOffering?: string | null;
  capabilities?: ProductCapability[];
}

/** Model statements stay inferred until their evidence is found in the read. */
export function parseCapabilities(raw: unknown, domain: string, sourceText = ""): ProductCapability[] {
  if (!Array.isArray(raw)) return [];
  const host = new URL(domain.startsWith("http") ? domain : `https://${domain}`).hostname.replace(/^www\./, "");
  return raw.flatMap((value) => {
    if (!value || typeof value !== "object" || typeof value.claim !== "string") return [];
    const claim = value.claim.trim().slice(0, 300);
    if (!claim) return [];
    let sourceUrl = "";
    try {
      const url = new URL(value.sourceUrl);
      if (/^https?:$/.test(url.protocol) && url.hostname.replace(/^www\./, "") === host) sourceUrl = url.href;
    } catch { /* no verified source */ }
    const quote = typeof value.quote === "string" ? value.quote.trim().slice(0, 500) : "";
    const page = sourceText.split(/(?=^SOURCE )/m).find((block) => block.split("\n", 1)[0] === `SOURCE ${sourceUrl}`);
    const supported = Boolean(sourceUrl && quote.length >= 15 && page?.slice(page.indexOf("\n") + 1).includes(quote));
    return [{ claim, sourceUrl, quote, status: supported ? "observed" as const : "inferred" as const }];
  }).slice(0, 8);
}
export function supportedCapabilities(focus: BusinessFocus | null | undefined): ProductCapability[] {
  return (focus?.capabilities ?? []).filter((c) => c.status === "observed" || c.status === "confirmed");
}
