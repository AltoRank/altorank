import { describe, it, expect } from "vitest";
import { plannerCardState, cardActions, cardStatusPill, dragBlockReason } from "../card-state";

const planned = { article_id: null, planned: true };
const linked = { article_id: "a1", planned: true };
const derived = { article_id: "a1", planned: false };

describe("plannerCardState", () => {
  it("a planned keyword with no article is planned", () => {
    expect(plannerCardState(planned, null)).toBe("planned");
  });

  it("a planned keyword whose draft is in flight is writing, before the link exists", () => {
    expect(plannerCardState(planned, null, true)).toBe("writing");
  });

  it("follows the article once one is linked", () => {
    expect(plannerCardState(linked, { status: "drafting" })).toBe("writing");
    expect(plannerCardState(linked, { status: "review" })).toBe("in_review");
    expect(plannerCardState(linked, { status: "draft" })).toBe("in_review");
    expect(plannerCardState(linked, { status: "approved" })).toBe("approved");
    expect(plannerCardState(linked, { status: "scheduled" })).toBe("scheduled");
    expect(plannerCardState(linked, { status: "live", published_url: "https://x/y" })).toBe("live");
    expect(plannerCardState(linked, { status: "error" })).toBe("failed");
  });

  it("an entry derived from an article reads the same way", () => {
    expect(plannerCardState(derived, { status: "live" })).toBe("live");
    expect(plannerCardState(derived, { status: "drafting" })).toBe("writing");
  });

  it("is unknown, not a guess, when the article could not be read or has a status it does not know", () => {
    expect(plannerCardState(linked, null)).toBe("unknown");
    expect(plannerCardState(linked, { status: "archived" })).toBe("unknown");
    expect(plannerCardState(linked, { status: "something-new" })).toBe("unknown");
    expect(plannerCardState({ article_id: null, planned: false }, null)).toBe("unknown");
  });
});

describe("cardActions", () => {
  it("a planned keyword offers the five planning actions and nothing about an article", () => {
    expect(cardActions("planned")).toEqual({
      writeNow: true, move: true, instructions: true, questions: true, remove: true,
      openDraft: false, openLive: false,
    });
  });

  it("writing offers nothing", () => {
    expect(Object.values(cardActions("writing")).some(Boolean)).toBe(false);
  });

  it("once an article exists the card only opens it", () => {
    for (const s of ["in_review", "approved", "scheduled", "failed"] as const) {
      const a = cardActions(s);
      expect(a.openDraft).toBe(true);
      expect(a.writeNow).toBe(false);
      expect(a.move).toBe(false);
      expect(a.remove).toBe(false);
    }
    expect(cardActions("live").openLive).toBe(true);
  });

  it("unknown offers nothing", () => {
    expect(Object.values(cardActions("unknown")).some(Boolean)).toBe(false);
  });
});

describe("cardStatusPill", () => {
  it("renders — for unknown (rule 5)", () => {
    expect(cardStatusPill("unknown").label).toBe("—");
  });

  it("names each state in the words the product uses", () => {
    expect(cardStatusPill("planned").label).toBe("Planned");
    expect(cardStatusPill("writing").label).toBe("Writing…");
    expect(cardStatusPill("in_review").label).toBe("In review");
    expect(cardStatusPill("live")).toEqual({ status: "live", label: "Live" });
  });
});

describe("dragBlockReason", () => {
  it("only a planned keyword moves", () => {
    expect(dragBlockReason("planned")).toBeNull();
  });

  it("says why every other state stays put", () => {
    for (const s of ["writing", "in_review", "approved", "scheduled", "live", "failed", "unknown"] as const) {
      expect(dragBlockReason(s)).toEqual(expect.any(String));
    }
  });
});
