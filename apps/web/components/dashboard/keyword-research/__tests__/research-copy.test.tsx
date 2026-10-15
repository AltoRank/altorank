import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/keyword-research", () => ({
  runGenerate: async () => ({}),
  saveKeywordInstructions: async () => {},
  loadResearchContext: async () => ({}),
  runPlaybook: async () => ({}),
  scheduleCandidates: async () => ({}),
  storeCandidates: async () => ({}),
}));

import { NO_AUDIENCES, NO_COMPETITORS } from "../generate-tab";
import { PLAYBOOKS_DESCRIPTION } from "../playbooks-dialog";

describe("keyword research copy", () => {
  it("points the empty pickers at Settings, not onboarding", () => {
    for (const line of [NO_AUDIENCES, NO_COMPETITORS]) {
      expect(line).toContain("Settings > Audience & Competitors");
      expect(line).not.toMatch(/onboarding/i);
    }
  });

  /** runPlaybook researches only; its own footer says nothing is scheduled. */
  it("does not say a playbook schedules keywords", () => {
    expect(PLAYBOOKS_DESCRIPTION).toContain("You choose which to keep from the results.");
    expect(PLAYBOOKS_DESCRIPTION).not.toMatch(/schedule/i);
  });
});
