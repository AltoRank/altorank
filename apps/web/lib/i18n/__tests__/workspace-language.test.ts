/**
 * A site whose language could not be read is "not checked", never English.
 *
 * The voice trainer answered "en" when its lookup failed, and the approval
 * gate and the SEO score passed `?? null`, which the contract reads as
 * English. A Turkish site with a failed read was scored, fact-checked and
 * voice-profiled with English rules, silently.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const recordEvent = vi.fn(async () => true);
vi.mock("@/lib/observability/record", () => ({ recordEvent }));

import { readWorkspaceLanguage } from "../workspace-language";
import { UNKNOWN_LANGUAGE, notCheckedFor, resolveLocale } from "../locale";
import { scoreArticle } from "@/lib/seo/scoring";
import { factCheckArticle } from "@/lib/ai/fact-check";
import { analyzeVoiceLocally } from "@/lib/voice/train";
import { voiceLanguageNote } from "@/lib/ai/voice-analyzer";

/** The one query shape the helper makes. */
function client(result: { data?: unknown; error?: { message: string } | null } | Error) {
  const maybeSingle = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return { data: result.data ?? null, error: result.error ?? null };
  });
  return {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
  } as never;
}

beforeEach(() => recordEvent.mockClear());

describe("readWorkspaceLanguage", () => {
  it("returns the stored language", async () => {
    expect(await readWorkspaceLanguage(client({ data: { language: "tr" } }), "ws-1", "test")).toBe("tr");
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("answers UNKNOWN_LANGUAGE, not English, when the read fails, and writes it down", async () => {
    expect(await readWorkspaceLanguage(client({ error: { message: "permission denied" } }), "ws-1", "test")).toBe(UNKNOWN_LANGUAGE);
    expect(await readWorkspaceLanguage(client({ data: null }), "ws-1", "test")).toBe(UNKNOWN_LANGUAGE);
    expect(await readWorkspaceLanguage(client(new Error("fetch failed")), "ws-1", "test")).toBe(UNKNOWN_LANGUAGE);
    expect(recordEvent).toHaveBeenCalledTimes(3);
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn", source: "locale.test", workspaceId: "ws-1", message: expect.stringContaining("permission denied") }),
    );
  });
});

describe("an unread language through the checks", () => {
  const html = "<h1>Web tasarımı</h1><p>Web tasarımı önemlidir. Pazar %20 büyüdü.</p>";

  it("resolves to unsupported and says why, not which languages it reads", () => {
    const locale = resolveLocale(UNKNOWN_LANGUAGE);
    expect(locale.supported).toBe(false);
    expect(notCheckedFor(locale)).toBe("Not checked: the site's language could not be read.");
  });

  it("the score, the fact check and the voice analyser do not read the text as English", () => {
    const unverified = scoreArticle(html, "web tasarımı", { language: UNKNOWN_LANGUAGE }).checks.filter((c) => c.unverified);
    expect(unverified.map((c) => c.note)).toEqual(Array(unverified.length).fill("Not checked: the site's language could not be read."));
    expect(unverified.length).toBeGreaterThan(0);
    expect(factCheckArticle(html, undefined, UNKNOWN_LANGUAGE).verdict).toBe("unchecked");
    expect(analyzeVoiceLocally("Ekibimiz her projeye dinleyerek başlar.", UNKNOWN_LANGUAGE).unchecked).toContain("could not be read");
    expect(voiceLanguageNote(UNKNOWN_LANGUAGE)).toContain("identify it from the text");
  });
});
