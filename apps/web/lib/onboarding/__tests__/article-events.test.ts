import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The article's way out, the browser's half: opened (and from where) and
// copied (which format, which button). Sent through trackStep.

const track = vi.fn();
vi.mock("../track-step", () => ({ trackStep: (...a: unknown[]) => track(...a) }));

import { trackArticleCopied, trackArticleOpened, type OpenedEnv } from "../article-events";

const A = "11111111-2222-4333-8444-555555555555";
const env = (over: Partial<OpenedEnv> = {}): OpenedEnv => ({
  pathname: `/content/${A}`,
  referrer: "",
  origin: "https://app.example",
  previous: () => null,
  ...over,
});

beforeEach(() => track.mockClear());
afterEach(() => vi.unstubAllGlobals());

describe("trackArticleOpened", () => {
  it("says the article and the app page before it, as a word", () => {
    trackArticleOpened(A, env({ previous: (here) => (here === `/content/${A}` ? "/onboarding" : null) }));
    expect(track).toHaveBeenCalledWith("article_opened", { articleId: A, props: { from: "setup", viewport: undefined } });
  });

  it("falls back to the referrer when the tab has no page before it", () => {
    trackArticleOpened(A, env({ referrer: "https://mail.example/u/0/#inbox/FMfcg" }));
    trackArticleOpened(A, env());
    expect(track.mock.calls.map((c) => (c[1] as { props: { from: string } }).props.from)).toEqual(["external", "direct"]);
    // Never the mail client's URL or anything from it.
    expect(JSON.stringify(track.mock.calls)).not.toContain("mail.example");
  });

  it("carries the viewport bucket, not the width", () => {
    vi.stubGlobal("window", { innerWidth: 390 });
    trackArticleOpened(A, env({ previous: () => "/articles" }));
    expect(track).toHaveBeenCalledWith("article_opened", { articleId: A, props: { from: "articles", viewport: "mobile" } });
  });

  it("says nothing outside a browser", () => {
    trackArticleOpened(A, null);
    expect(track).not.toHaveBeenCalled();
  });
});

describe("trackArticleCopied", () => {
  it("says which format went to the clipboard from which button", () => {
    trackArticleCopied(A, "markdown", "export_preview");
    expect(track).toHaveBeenCalledWith("article_copied", { articleId: A, props: { format: "markdown", surface: "export_preview" } });
  });
});
