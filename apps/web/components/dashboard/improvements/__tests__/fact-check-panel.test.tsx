import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The review page shows the rewrite's own fact check beside the diff. It was
// stored on every execution and read by nothing, so a rewrite full of
// unsourced figures reached the reviewer with no sign of them.

vi.mock("@/app/actions/refresh", () => ({
  exportExecutionAction: vi.fn(),
  pushExecutionAction: vi.fn(),
  rejectExecution: vi.fn(),
  saveExecutionDecisions: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { FactCheckPanel } = await import("../review-execution");

describe("FactCheckPanel", () => {
  it("lists the claims the fact check flagged, with its summary", () => {
    const html = renderToStaticMarkup(
      <FactCheckPanel
        factCheck={{
          verdict: "high_risk",
          report: {
            verdict: "high_risk",
            summary: "1 unsourced claim to correct or remove.",
            counts: { high: 1, medium: 0, low: 1, total: 2 },
            claims: [
              { id: "c1", kind: "statistic", status: "unsourced", severity: "high", text: "73%", figures: ["73%"], sentence: "73% of patients recover faster.", attribution: null, sourceUrl: null, note: "Add a source" },
              { id: "c2", kind: "statistic", status: "verified", severity: "low", text: "12", figures: ["12"], sentence: "12 clinics.", attribution: "NHS", sourceUrl: "https://nhs.example", note: "" },
            ],
          },
        }}
      />,
    );
    expect(html).toContain("claims to correct or remove");
    expect(html).toContain("1 unsourced claim to correct or remove.");
    expect(html).toContain("73% of patients recover faster.");
    expect(html).not.toContain("12 clinics.");
    expect(html).toContain("Push checks the figures again");
  });

  it("says when only the verdict was stored, and renders nothing without one", () => {
    expect(renderToStaticMarkup(<FactCheckPanel factCheck={{ verdict: "review", report: null }} />)).toContain(
      "Only the verdict was stored",
    );
    expect(renderToStaticMarkup(<FactCheckPanel factCheck={null} />)).toBe("");
  });
});
