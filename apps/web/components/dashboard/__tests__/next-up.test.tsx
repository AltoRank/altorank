import { describe, expect, it, vi, beforeEach } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Next up's two links say which one was followed (onboarding.step
// next_up_clicked). No DOM in this repo's tests: the element tree is walked
// and each link's click handler called, as a click would.

const clicked = vi.fn();
vi.mock("@/lib/onboarding/article-events", () => ({ trackNextUpClicked: (...a: unknown[]) => clicked(...a) }));

import { NextUp } from "../next-up";

const DRAFT = { id: "11111111-2222-4333-8444-555555555555", title: "How to pick a dental clinic" };

/** Every element in the tree with an href, by href. */
function links(node: ReactNode, out = new Map<string, ReactElement<{ onClick?: () => void }>>()) {
  if (Array.isArray(node)) node.forEach((n) => links(n, out));
  else if (isValidElement<{ href?: string; children?: ReactNode }>(node)) {
    if (typeof node.props.href === "string") out.set(node.props.href, node as ReactElement<{ onClick?: () => void }>);
    links(node.props.children, out);
  }
  return out;
}

beforeEach(() => clicked.mockClear());

describe("NextUp", () => {
  it("says the draft was followed from Next up", () => {
    links(NextUp({ draft: DRAFT, waiting: 1, autoApprove: false })).get(`/content/${DRAFT.id}`)!.props.onClick!();
    expect(clicked).toHaveBeenCalledWith(DRAFT.id, "draft");
  });

  it("says the rest of the queue was followed instead, when there is more waiting", () => {
    const found = links(NextUp({ draft: DRAFT, waiting: 3, autoApprove: false }));
    found.get("/articles?status=review")!.props.onClick!();
    expect(clicked).toHaveBeenCalledWith(DRAFT.id, "more");
    expect(links(NextUp({ draft: DRAFT, waiting: 1, autoApprove: false })).has("/articles?status=review")).toBe(false);
  });

  it("still renders as it did: the title, the one accent button", () => {
    const html = renderToStaticMarkup(<NextUp draft={DRAFT} waiting={3} autoApprove={false} />);
    expect(html).toContain("How to pick a dental clinic");
    expect(html).toContain("Read and approve");
    expect(html).toContain("2 more drafts");
    expect(clicked).not.toHaveBeenCalled();
  });

  it("does not promise a wait for approval on a site that approves on its own", () => {
    expect(renderToStaticMarkup(<NextUp draft={DRAFT} waiting={1} autoApprove={false} />)).toContain("Nothing publishes until you approve it.");
    const auto = renderToStaticMarkup(<NextUp draft={DRAFT} waiting={1} autoApprove />);
    expect(auto).not.toContain("Nothing publishes until you approve it");
    expect(auto).toContain("Auto-approve is on");
  });

  it("in the trial's first days, asks for the first article with one button", () => {
    const html = renderToStaticMarkup(<NextUp draft={DRAFT} waiting={8} autoApprove={false} first />);
    expect(html).toContain("Review your first article");
    expect(html).toContain("How to pick a dental clinic");
    expect(html).toContain("Review draft");
    expect(html).not.toContain("Read and approve");
    expect(html.match(/<button/g)).toHaveLength(1);
  });
});
