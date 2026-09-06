import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RewriteHunkList } from "../rewrite-review";
import { KeptCounter } from "@/components/dashboard/review/hunk-controls";
import { proposeHunks, decideAll, reviewableHunks } from "@/lib/editor/proposals";

// renderToStaticMarkup, as the other editor panel tests do: no jsdom here, and
// the list is presentation over a hunk array, so the rendered string is the
// assertion surface.

const before = "<h2>Intro</h2><p>old one</p><p>same</p>";
const after = "<h2>Intro</h2><p>new one</p><p>same</p><ul><li>added</li></ul>";
const hunks = proposeHunks(before, after);
const open = reviewableHunks(hunks);
const noop = () => {};

function render(decisions: Record<string, "accepted" | "rejected">) {
  return renderToStaticMarkup(
    <RewriteHunkList hunks={hunks} decisions={decisions} focusedId={null} compareId={null} onDecide={noop} onFocus={noop} onCompare={noop} />,
  );
}

describe("RewriteHunkList", () => {
  it("chips every changed block and prints unchanged ones without a chip", () => {
    const html = render(decideAll(hunks, "accepted"));
    expect(html.match(/REWRITTEN/g)).toHaveLength(1);
    expect(html).toContain("ADDED");
    expect(html).not.toContain("REMOVED");
    const removed = proposeHunks("<p>a</p><p>b</p>", "<p>a</p>");
    expect(
      renderToStaticMarkup(
        <RewriteHunkList hunks={removed} decisions={decideAll(removed, "accepted")} focusedId={null} compareId={null} onDecide={noop} onFocus={noop} onCompare={noop} />,
      ),
    ).toContain("REMOVED");
    // Unchanged blocks are context, not decisions.
    expect(html.match(/data-hunk-id=/g)).toHaveLength(open.length);
    expect(html).toContain("<h2>Intro</h2>");
    expect(html).toContain("<p>same</p>");
  });

  it("shows the rewrite for a kept block and the original for a rejected one", () => {
    const [changed] = open;
    expect(render(decideAll(hunks, "accepted"))).toContain("<p>new one</p>");
    const rejected = render({ ...decideAll(hunks, "accepted"), [changed.id]: "rejected" });
    expect(rejected).toContain("<p>old one</p>");
    expect(rejected).not.toContain("<p>new one</p>");
  });

  it("says out loud that a rejected addition stays out", () => {
    const html = render(decideAll(hunks, "rejected"));
    expect(html).toContain("This block would be added. Rejected, so it stays out.");
    expect(html).not.toContain("<li>added</li>");
  });

  it("strips executable markup from model blocks before rendering", () => {
    const h = proposeHunks("<p>a</p>", '<p onclick="x()">a <script>alert(1)</script></p>');
    const html = renderToStaticMarkup(
      <RewriteHunkList hunks={h} decisions={decideAll(h, "accepted")} focusedId={null} compareId={null} onDecide={noop} onFocus={noop} onCompare={noop} />,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onclick");
  });
});

describe("KeptCounter", () => {
  it("reads N / M kept", () => {
    expect(renderToStaticMarkup(<KeptCounter kept={2} total={5} />).replace(/<!-- -->/g, "")).toContain("2 / 5 kept");
  });
});
