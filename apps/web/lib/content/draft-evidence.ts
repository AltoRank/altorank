import { readPageExtract, type PageExtract } from "@/lib/keyword-research/page-evidence";
import { supportedCapabilities, type BusinessFocus } from "@/lib/onboarding/profile-focus";

/** A small source packet shared by the writer and reviewer, including claim context. */
export async function collectDraftEvidence(profile: BusinessFocus | null, conversionUrl: string | undefined, searchUrls: string[]): Promise<PageExtract[]> {
  const product = [...new Set([conversionUrl, ...supportedCapabilities(profile).map(c => c.sourceUrl)].filter((u): u is string => Boolean(u)))].slice(0, 2);
  const urls = [...new Set([...product, ...searchUrls.slice(0, 3)])].slice(0, 5);
  const pages = await Promise.all(urls.map(url => readPageExtract(url, 9000)));
  return pages.filter((page): page is PageExtract => page !== null);
}
