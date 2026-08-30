import { describe, it, expect } from "vitest";
import { resolveContentPath, buildFrontmatter } from "../git";

const DIR = "apps/marketing/src/content/blog";

describe("resolveContentPath — path traversal", () => {
  // The slug reaching this function was written by a language model, and the
  // token behind it can write to a repository. Escaping the content directory
  // turns a blog publisher into arbitrary CI execution.

  it("writes an ordinary slug inside the content directory", () => {
    expect(resolveContentPath(DIR, "agency-seo", "mdx")).toBe(`${DIR}/agency-seo.mdx`);
  });

  it("neutralises a traversal attempt", () => {
    const p = resolveContentPath(DIR, "../../../.github/workflows/deploy");
    expect(p.startsWith(`${DIR}/`)).toBe(true);
    expect(p).not.toContain("..");
    expect(p).not.toContain(".github");
  });

  it("strips path separators from the slug", () => {
    const p = resolveContentPath(DIR, "nested/evil/post");
    expect(p).toBe(`${DIR}/nested-evil-post.md`);
  });

  it("refuses an absolute-looking slug", () => {
    const p = resolveContentPath(DIR, "/etc/passwd");
    expect(p).toBe(`${DIR}/etc-passwd.md`);
  });

  it("cannot be given a different extension through the slug", () => {
    const p = resolveContentPath(DIR, "post.yml", "md");
    expect(p.endsWith(".md")).toBe(true);
    expect(p).toBe(`${DIR}/post-yml.md`);
  });

  it("rejects a contentPath containing ..", () => {
    expect(() => resolveContentPath("../../etc", "post")).toThrow(/\.\./);
  });

  it("rejects an empty contentPath", () => {
    expect(() => resolveContentPath("", "post")).toThrow(/required/);
  });

  it("rejects a slug that sanitises to nothing", () => {
    expect(() => resolveContentPath(DIR, "!!!")).toThrow(/empty/);
  });

  it("tolerates surrounding slashes on the directory", () => {
    expect(resolveContentPath(`/${DIR}/`, "post")).toBe(`${DIR}/post.md`);
  });

  it("caps an absurdly long slug", () => {
    const p = resolveContentPath(DIR, "a".repeat(400));
    expect(p.length).toBeLessThan(DIR.length + 130);
  });
});

describe("buildFrontmatter", () => {
  it("quotes strings and renders arrays and booleans", () => {
    const fm = buildFrontmatter({
      title: "Agency SEO",
      tags: ["seo", "agencies"],
      draft: false,
    });
    expect(fm).toContain('title: "Agency SEO"');
    expect(fm).toContain('tags: ["seo", "agencies"]');
    expect(fm).toContain("draft: false");
    expect(fm.startsWith("---\n")).toBe(true);
  });

  it("escapes quotes so a title cannot break out of the YAML scalar", () => {
    const fm = buildFrontmatter({ title: 'The "Best" Tool' });
    expect(fm).toContain('title: "The \\"Best\\" Tool"');
  });

  it("omits undefined fields rather than emitting empty keys", () => {
    const fm = buildFrontmatter({ title: "X", ogImage: undefined });
    expect(fm).not.toContain("ogImage");
  });
});
