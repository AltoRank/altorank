import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Counter } from "../counter";

// renderToStaticMarkup, as the other editor tests do: no jsdom in this repo,
// and a counter is a string and a class.

describe("Counter", () => {
  it("shows N/60 for a title in the quiet colour", () => {
    const html = renderToStaticMarkup(<Counter text="Twelve chars" field="title" />);
    expect(html).toContain("12/60");
    expect(html).toContain("text-ink-3");
    expect(html).not.toContain("text-err-ink");
  });

  it("shows N/160 for a meta description and turns red past 160", () => {
    const ok = renderToStaticMarkup(<Counter text={"x".repeat(160)} field="meta_description" />);
    expect(ok).toContain("160/160");
    expect(ok).not.toContain("text-err-ink");

    const over = renderToStaticMarkup(<Counter text={"x".repeat(171)} field="meta_description" />);
    expect(over).toContain("171/160");
    expect(over).toContain("text-err-ink");
    expect(over).toContain("over the limit");
  });
});
