import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/app/actions/onboarding-wizard", () => ({ saveKeywordPrompt: async () => {} }));

import { KEYWORD_PROMPT_HINT, KeywordPromptForm } from "../keyword-prompt-form";

describe("KeywordPromptForm", () => {
  /**
   * Only the Research keywords drawer and Playbooks read the instructions
   * (readKeywordInstructions); setup research and the queue top-up do not.
   */
  it("says which research reads the instructions, and which does not", () => {
    expect(KEYWORD_PROMPT_HINT).not.toContain("research follows these");
    expect(KEYWORD_PROMPT_HINT).toContain("Research keywords and Playbooks");
    expect(KEYWORD_PROMPT_HINT).toContain("does not read it yet");
    const html = renderToStaticMarkup(<KeywordPromptForm workspaceId="ws-1" initial="" />);
    expect(html).toContain("Research keywords and Playbooks");
  });
});
