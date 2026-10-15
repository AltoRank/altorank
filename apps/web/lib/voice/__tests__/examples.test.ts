import { describe, expect, it, vi } from "vitest";
import {
  composeVoiceSample,
  hasTrainedVoice,
  readExampleArticles,
  retrainFromExamples,
  withoutChosenArticles,
} from "@/lib/voice/examples";

const words = (n: number, w = "word") => Array.from({ length: n }, () => w).join(" ");

describe("readExampleArticles", () => {
  it("reads at most three chosen articles, each under its SOURCE line, skipping any that did not answer", async () => {
    const read = vi.fn(async (url: string) => ({ text: url.endsWith("/b") ? "" : `text of ${url}` }));
    const out = await readExampleArticles(["https://a.co/a", "https://a.co/b", "https://a.co/c", "https://a.co/d"], read);
    expect(read).toHaveBeenCalledTimes(3);
    expect(out).toBe("SOURCE https://a.co/a\ntext of https://a.co/a\n\nSOURCE https://a.co/c\ntext of https://a.co/c");
  });

  it("reads nothing when none were chosen", async () => {
    const read = vi.fn();
    expect(await readExampleArticles([], read)).toBe("");
    expect(read).not.toHaveBeenCalled();
  });
});

describe("composeVoiceSample", () => {
  it("puts the chosen articles before the site text", () => {
    expect(composeVoiceSample("CHOSEN", "SITE")).toBe("CHOSEN\n\nSITE");
    expect(composeVoiceSample("", "SITE")).toBe("SITE");
    expect(composeVoiceSample("x".repeat(20), "SITE", 10)).toBe("x".repeat(10));
  });
});

describe("withoutChosenArticles", () => {
  it("drops the blocks of articles chosen before and keeps the site's own pages", () => {
    const sample = "SOURCE https://a.co/old\nold text\n\nSOURCE https://a.co/pricing\npricing text\n\nHOMEPAGE/BLOG CONTEXT\nhome";
    expect(withoutChosenArticles(sample, ["https://a.co/old"])).toBe(
      "SOURCE https://a.co/pricing\npricing text\n\nHOMEPAGE/BLOG CONTEXT\nhome",
    );
  });
});

function voiceClient(profile: { sample_text: string; trained: boolean } | null) {
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.eq = () => b;
  b.maybeSingle = async () => ({ data: profile, error: null });
  return { from: () => b } as never;
}

describe("retrainFromExamples", () => {
  it("retrains a trained voice from the newly chosen articles first, replacing the old ones", async () => {
    const train = vi.fn(async () => {});
    const read = async (url: string) => ({ text: `${url} ${words(60)}` });
    const done = await retrainFromExamples(
      voiceClient({ sample_text: "SOURCE https://a.co/old\nold text\n\nHOMEPAGE/BLOG CONTEXT\nhome", trained: true }),
      "ws-1",
      ["https://a.co/new"],
      ["https://a.co/old"],
      { read, train },
    );
    expect(done).toBe(true);
    const sample = (train.mock.calls[0] as unknown as [unknown, string, string])[2];
    expect(sample.startsWith("SOURCE https://a.co/new\n")).toBe(true);
    expect(sample).toContain("HOMEPAGE/BLOG CONTEXT\nhome");
    expect(sample).not.toContain("old text");
  });

  it("leaves an untrained site to onboarding, and ignores articles too short to learn from", async () => {
    const train = vi.fn(async () => {});
    const read = async () => ({ text: words(60) });
    expect(await retrainFromExamples(voiceClient(null), "ws-1", ["https://a.co/x"], [], { read, train })).toBe(false);
    expect(
      await retrainFromExamples(voiceClient({ sample_text: "", trained: true }), "ws-1", ["https://a.co/x"], [], {
        read: async () => ({ text: "too short" }),
        train,
      }),
    ).toBe(false);
    expect(train).not.toHaveBeenCalled();
  });
});

describe("hasTrainedVoice", () => {
  it("is true only for a trained profile, so Settings promises a retrain only then", async () => {
    expect(await hasTrainedVoice(voiceClient({ sample_text: "x", trained: true }), "ws-1")).toBe(true);
    expect(await hasTrainedVoice(voiceClient({ sample_text: "x", trained: false }), "ws-1")).toBe(false);
    expect(await hasTrainedVoice(voiceClient(null), "ws-1")).toBe(false);
  });
});
