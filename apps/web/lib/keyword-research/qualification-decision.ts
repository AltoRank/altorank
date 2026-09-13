import type { SerpData } from "@/lib/seo/brief-data";
import type { PageExtract } from "./page-evidence";
export interface QualificationAssessment {
  results: Array<{ resultIndex?: number; evidenceField?: "title" | "description" | "page"; url: string; format: "article" | "product" | "service" | "tool" | "navigation" | "unknown"; quote: string }>;
  buyer: { relevant: boolean; reason: string };
  product: { supported: boolean; quote: string; reason: string };
  editorial: { achievable: boolean; reason: string };
  existingPage?: { url: string; sameTask: boolean; quote: string; reason: string };
  audience: string; buyingJob: string; offering: string; angle: string; conversionPath: string;
}
export type AssessmentDecision = { status: "qualified" | "rejected" | "pending"; reason: string; evidenceUrls: string[]; contradictions: string[]; assessment?: QualificationAssessment; existingUrl?: string };
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const pending = (reason: string, contradictions: string[] = []): AssessmentDecision => ({ status: "pending", reason, evidenceUrls: [], contradictions });
export function assessQualification(raw: unknown, organic: SerpData["organic"], businessEvidence: string, extracts: PageExtract[], ownUrl?: string | null): AssessmentDecision {
  if (!raw || typeof raw !== "object") return pending("The evidence check was incomplete. Retry research.");
  const a = raw as QualificationAssessment;
  if (!Array.isArray(a.results) || !a.buyer || typeof a.buyer.relevant !== "boolean" || !text(a.buyer.reason) || !a.product || typeof a.product.supported !== "boolean" || !text(a.product.reason) || !a.editorial || typeof a.editorial.achievable !== "boolean" || !text(a.editorial.reason)) return pending("The evidence check was incomplete. Retry research.");
  // The model names an observed row and evidence field; the server attaches
  // the exact URL and quotation, avoiding transcription errors and invented URLs.
  a.results = a.results.map((r) => {
    if (!r || !Number.isInteger(r.resultIndex)) return r;
    const original = organic[r.resultIndex!];
    if (!original) return r;
    const quote = r.evidenceField === "title" ? original.title : r.evidenceField === "description" ? original.description : r.evidenceField === "page" ? extracts.find((e) => e.url === original.url)?.text : "";
    return {...r, url: original.url, quote: quote ?? ""};
  });
  const seen = new Set<string>(); const contradictions: string[] = [];
  for (const r of a.results) {
    const original = organic.find((o) => o.url === r?.url); const extract = extracts.find((e) => e.url === r?.url);
    const evidence = [original?.title, original?.description, extract?.title, extract?.headings.join(" "), extract?.text].filter(Boolean).join(" ");
    if (!original || seen.has(r.url) || !["article","product","service","tool","navigation","unknown"].includes(r.format) || !text(r.quote) || !evidence.includes(r.quote)) return { ...pending("A result classification lacked an exact observed source. Retry research."), assessment: a };
    seen.add(r.url);
    if (["product","tool","navigation"].includes(r.format) && /\b(best|top \d+|comparison|alternatives|guide|migliori|confronto)\b/i.test(original.title) && !extract) contradictions.push(`Check ${r.url}: its title suggests an editorial guide.`);
  }
  if (seen.size !== organic.length) return pending("Some search results were not classified. Retry research.");
  const evidenceUrls = a.results.filter((r) => r.format === "article").map((r) => r.url);
  if (a.product.supported && (!text(a.product.quote) || !businessEvidence.includes(a.product.quote))) contradictions.push("The product relationship lacks exact supporting business evidence.");
  if (ownUrl) {
    const own = extracts.find((e) => e.url === ownUrl);
    if (!own || !a.existingPage || a.existingPage.url !== ownUrl || typeof a.existingPage.sameTask !== "boolean" || !text(a.existingPage.quote) || ![own.title,...own.headings,own.text].join(" ").includes(a.existingPage.quote)) return pending("Your ranking page needs a content check before choosing an update or new article.");
    if (a.existingPage.sameTask) return { status: "rejected", reason: a.existingPage.reason || "Your existing page already serves this task.", existingUrl: ownUrl, evidenceUrls, contradictions: [], assessment: a };
  }
  if (contradictions.length) return { ...pending("The search evidence needs a second review.", contradictions), evidenceUrls, assessment: a };
  const qualified = a.buyer.relevant && a.product.supported && evidenceUrls.length >= 2 && a.editorial.achievable;
  if (qualified && ![a.audience,a.buyingJob,a.offering,a.angle,a.conversionPath].every(text)) return pending("The article brief was incomplete. Retry research.");
  const reason = !a.buyer.relevant ? a.buyer.reason : !a.product.supported ? a.product.reason : evidenceUrls.length < 2 ? "Fewer than two observed results support an editorial article." : a.editorial.reason;
  return { status: qualified ? "qualified" : "rejected", reason: reason.slice(0,400), evidenceUrls, contradictions, assessment: a };
}
