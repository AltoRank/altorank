import { describe, expect, it } from "vitest";
import {
  MAX_REF,
  MAX_SRC,
  MAX_UTM,
  describeSignupSource,
  parseSignupSource,
  signupSourceContext,
  signupSourceFields,
  signupSourceQuery,
} from "../signup-source";
import { buildEventRow } from "@/lib/observability/event";

describe("parseSignupSource", () => {
  it("reads src, ref and the five utm params from searchParams", () => {
    expect(
      parseSignupSource({
        src: "/pricing/",
        ref: "news.ycombinator.com",
        utm_source: "newsletter",
        utm_medium: "email",
        utm_campaign: "october-launch",
        utm_term: "seo tool",
        utm_content: "footer_cta",
      }),
    ).toEqual({
      src: "/pricing/",
      ref: "news.ycombinator.com",
      utm: {
        utm_source: "newsletter",
        utm_medium: "email",
        utm_campaign: "october-launch",
        utm_term: "seo tool",
        utm_content: "footer_cta",
      },
    });
  });

  it("reads the same values back from the form the page rendered", () => {
    const form = new FormData();
    form.set("email", "a@example.com");
    form.set("src", "/blog/how-to-rank-in-chatgpt/");
    form.set("ref", "www.google.com");
    form.set("utm_source", "reddit");
    expect(parseSignupSource(form)).toEqual({
      src: "/blog/how-to-rank-in-chatgpt/",
      ref: "www.google.com",
      utm: { utm_source: "reddit" },
    });
  });

  it("returns an empty source when nothing was sent", () => {
    expect(parseSignupSource({})).toEqual({});
    expect(parseSignupSource(new FormData())).toEqual({});
    expect(parseSignupSource(undefined)).toEqual({});
  });

  it("takes the first value of a repeated param", () => {
    expect(parseSignupSource({ src: ["/a/", "/b/"], utm_source: ["x", "y"] })).toEqual({
      src: "/a/",
      utm: { utm_source: "x" },
    });
  });

  it("does not read `from`, which is the tools signup's mode and not attribution", () => {
    expect(parseSignupSource({ from: "tools", return_to: "https://altorank.co/tools/x/" })).toEqual({});
  });

  it("ignores utm params outside the standard five", () => {
    expect(parseSignupSource({ utm_id: "123", utm_source_platform: "x" })).toEqual({});
  });

  it("drops a src that is not a path", () => {
    for (const src of ["pricing", "https://evil.example/", "//evil.example/", "/a b", "/<script>", '/"x', "/a?b=c", "/a#b"]) {
      expect(parseSignupSource({ src }).src, src).toBeUndefined();
    }
  });

  it("drops a ref that is not a hostname, and lowercases one that is", () => {
    for (const ref of ["https://x.com/", "x.com/path", "x .com", "-x.com", "x..com", "<b>", "x_y.com"]) {
      expect(parseSignupSource({ ref }).ref, ref).toBeUndefined();
    }
    expect(parseSignupSource({ ref: "News.YCombinator.com." }).ref).toBe("news.ycombinator.com");
    expect(parseSignupSource({ ref: "xn--bcher-kva.example" }).ref).toBe("xn--bcher-kva.example");
  });

  it("keeps free-text campaign names but drops markup and URL syntax", () => {
    expect(parseSignupSource({ utm_campaign: "lancio città  2026" }).utm).toEqual({ utm_campaign: "lancio città 2026" });
    for (const v of ["<img>", "a&b=c", "x;drop", 'say "hi"', "a\u0000b", "a\nb=c", "100%"]) {
      expect(parseSignupSource({ utm_campaign: v }).utm, JSON.stringify(v)).toBeUndefined();
    }
  });

  it("drops a value over its cap rather than storing a truncated one", () => {
    expect(parseSignupSource({ src: "/" + "a".repeat(MAX_SRC) }).src).toBeUndefined();
    expect(parseSignupSource({ src: "/" + "a".repeat(MAX_SRC - 1) }).src).toHaveLength(MAX_SRC);
    expect(parseSignupSource({ ref: "a".repeat(MAX_REF - 4) + ".com" }).ref).toHaveLength(MAX_REF);
    expect(parseSignupSource({ ref: "a".repeat(MAX_REF - 3) + ".com" }).ref).toBeUndefined();
    expect(parseSignupSource({ utm_source: "x".repeat(MAX_UTM) }).utm).toEqual({ utm_source: "x".repeat(MAX_UTM) });
    expect(parseSignupSource({ utm_source: "x".repeat(MAX_UTM + 1) }).utm).toBeUndefined();
  });

  it("keeps the good values when one is bad", () => {
    expect(parseSignupSource({ src: "/pricing/", ref: "not a host", utm_source: "ok", utm_medium: "<x>" })).toEqual({
      src: "/pricing/",
      utm: { utm_source: "ok" },
    });
  });
});

describe("carrying the source through the form and redirects", () => {
  const source = parseSignupSource({ src: "/check/", ref: "t.co", utm_source: "x", utm_campaign: "spring sale" });

  it("lists one field per value, in a stable order", () => {
    expect(signupSourceFields(source)).toEqual([
      ["src", "/check/"],
      ["ref", "t.co"],
      ["utm_source", "x"],
      ["utm_campaign", "spring sale"],
    ]);
  });

  it("builds a query tail that parses back to the same source", () => {
    const tail = signupSourceQuery(source);
    expect(tail.startsWith("&")).toBe(true);
    const url = new URL("https://app.altorank.co/signup?error=Nope" + tail);
    expect(url.searchParams.get("error")).toBe("Nope");
    expect(parseSignupSource(Object.fromEntries(url.searchParams))).toEqual(source);
  });

  it("adds nothing to a redirect when there is nothing to carry", () => {
    expect(signupSourceQuery({})).toBe("");
  });
});

describe("recording the source", () => {
  it("records { src, ref, utm } with utm keyed by its short name", () => {
    expect(
      signupSourceContext(parseSignupSource({ src: "/", ref: "chatgpt.com", utm_source: "a", utm_medium: "b" })),
    ).toEqual({ src: "/", ref: "chatgpt.com", utm: { source: "a", medium: "b" } });
    expect(signupSourceContext({})).toEqual({});
  });

  it("survives the event sanitiser unchanged (no key reads as a secret)", () => {
    const attribution = signupSourceContext(
      parseSignupSource({
        src: "/pricing/",
        ref: "perplexity.ai",
        utm_source: "s",
        utm_medium: "m",
        utm_campaign: "c",
        utm_term: "t",
        utm_content: "k",
      }),
    );
    const row = buildEventRow({ level: "info", source: "signup", message: "Account created", context: attribution });
    expect(row.context).toEqual(attribution);
  });

  it("describes the source in one line, or says it is unknown", () => {
    expect(describeSignupSource(parseSignupSource({ src: "/pricing/", ref: "news.ycombinator.com", utm_source: "hn" }))).toBe(
      "from /pricing/ via news.ycombinator.com, utm_source hn",
    );
    expect(describeSignupSource(parseSignupSource({ utm_campaign: "oct" }))).toBe("utm_campaign oct");
    expect(describeSignupSource({})).toBe("source unknown");
  });
});
