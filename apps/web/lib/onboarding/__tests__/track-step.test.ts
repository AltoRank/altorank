import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The browser's half of onboarding.step: a keepalive POST, once per step per
// page load - per ending, article or copy button for the steps that have one.

const fetchMock = vi.fn(async (..._a: unknown[]) => new Response(null, { status: 204 }));
const bodies = () => fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string));

let trackStep: typeof import("../track-step").trackStep;
beforeEach(async () => {
  vi.resetModules();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  ({ trackStep } = await import("../track-step"));
});
afterEach(() => vi.unstubAllGlobals());

describe("trackStep", () => {
  it("posts the step and its props without waiting, and keeps the request alive past a navigation", () => {
    trackStep("setup_ending_shown", { workspaceId: "ws1", props: { ending: "article" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/onboard/step");
    expect(init).toMatchObject({ method: "POST", keepalive: true });
    expect(bodies()[0]).toEqual({ step: "setup_ending_shown", workspaceId: "ws1", props: { ending: "article" } });
  });

  it("says each ending once, and a second ending too", () => {
    trackStep("setup_ending_shown", { props: { ending: "writing" } });
    trackStep("setup_ending_shown", { props: { ending: "writing" } });
    trackStep("setup_ending_shown", { props: { ending: "article" } });
    expect(bodies().map((b) => b.props.ending)).toEqual(["writing", "article"]);
  });

  it("says offer_seen once per page load, whatever the viewport does after", () => {
    trackStep("offer_seen", { props: { viewport: "mobile" } });
    trackStep("offer_seen", { props: { viewport: "desktop" } });
    expect(bodies()).toEqual([{ step: "offer_seen", props: { viewport: "mobile" } }]);
  });

  it("keeps copies apart by article, format and button", () => {
    const a = "11111111-2222-4333-8444-555555555555";
    trackStep("article_copied", { articleId: a, props: { format: "html", surface: "publish_panel" } });
    trackStep("article_copied", { articleId: a, props: { format: "html", surface: "publish_panel" } });
    trackStep("article_copied", { articleId: a, props: { format: "markdown", surface: "publish_panel" } });
    trackStep("article_copied", { articleId: a, props: { format: "markdown", surface: "export_menu" } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("never throws, whatever the network does", () => {
    fetchMock.mockImplementationOnce(() => {
      throw new Error("offline");
    });
    expect(() => trackStep("wizard_opened")).not.toThrow();
  });
});
