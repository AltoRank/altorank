import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/app/actions/gate-answer", () => ({ answerGate: async () => ({ ok: true }) }));

import { GateQuestion } from "../gate-question";

describe("the gate's question", () => {
  // Folded: a person about to press Start trial is not shown reasons not to.
  it("is one quiet line until it is opened", () => {
    const html = renderToStaticMarkup(<GateQuestion workspaceId="ws1" />);
    expect(html).toContain("Not starting the trial? Tell us what stopped you");
    expect(html).not.toContain("It costs too much");
    expect(html.match(/<button/g)).toHaveLength(1);
  });
});
