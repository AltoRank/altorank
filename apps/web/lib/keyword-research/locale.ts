import { LOCALES } from "@/lib/seo/locales";
export function languageCodeOf(raw: string | null | undefined): string {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return "en";
  if (LOCALES[v]) return LOCALES[v].languageCode;
  const hit = Object.values(LOCALES).find((e) => e.label.toLowerCase() === v || e.languageCode.toLowerCase() === v);
  return hit?.languageCode ?? "en";
}
