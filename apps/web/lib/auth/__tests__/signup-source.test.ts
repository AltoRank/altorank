import { describe, expect, it } from "vitest";
import {
  MAX_REF,
  MAX_SRC,
  MAX_UTM,
  describeSignupSource,
  parseSignupSource,
  signupSourceContext,
  refererHost,
  signupSourceFields,
  signupSourceHref,
  signupSourceQuery,
  withRefererFallback,
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

  it("reads the landing path `lp` with the same path rules as `src`", () => {
    expect(parseSignupSource({ src: "/pricing/", lp: "/alternatives/outrank/" })).toEqual({
      src: "/pricing/",
      lp: "/alternatives/outrank/",
    });
    const form = new FormData();
    form.set("lp", "/blog/how-to-rank-in-chatgpt/");
    expect(parseSignupSource(form)).toEqual({ lp: "/blog/how-to-rank-in-chatgpt/" });
    for (const lp of ["pricing", "https://evil.example/", "//evil.example/", "/<script>", "/a?b=c", "/" + "a".repeat(MAX_SRC)]) {
      expect(parseSignupSource({ lp }).lp, lp).toBeUndefined();
    }
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
  const source = parseSignupSource({ src: "/check/", lp: "/tools/x/", ref: "t.co", utm_source: "x", utm_campaign: "spring sale" });

  it("lists one field per value, in a stable order", () => {
    expect(signupSourceFields(source)).toEqual([
      ["src", "/check/"],
      ["lp", "/tools/x/"],
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

  it("appends the source to a link, after any query it already has", () => {
    expect(signupSourceHref("/signup", {})).toBe("/signup");
    const plain = new URL(signupSourceHref("/signup", source), "https://app.altorank.co");
    expect(plain.pathname).toBe("/signup");
    expect(parseSignupSource(Object.fromEntries(plain.searchParams))).toEqual(source);
    const withQuery = new URL(signupSourceHref("/signin/code?next=%2Fdashboard", source), "https://app.altorank.co");
    expect(withQuery.searchParams.get("next")).toBe("/dashboard");
    expect(parseSignupSource(Object.fromEntries(withQuery.searchParams))).toEqual(source);
  });
});

describe("the Referer header as the fallback `ref`", () => {
  it("keeps the referring site's hostname, lowercased, and nothing else of the URL", () => {
    expect(refererHost("https://chatgpt.com/")).toBe("chatgpt.com");
    expect(refererHost("https://www.Perplexity.ai/search?q=seo+tool")).toBe("www.perplexity.ai");
    expect(refererHost("http://news.ycombinator.com:8080/item?id=1")).toBe("news.ycombinator.com");
  });

  it("ignores a missing, unparseable or non-host Referer", () => {
    for (const referer of [null, undefined, "", "not a url", "/relative/path", "file:///tmp/x.html"]) {
      expect(refererHost(referer), String(referer)).toBeUndefined();
    }
  });

  it("keeps an Android app's package name, which is what its Referer carries", () => {
    expect(refererHost("android-app://com.google.android.googlequicksearchbox/")).toBe("com.google.android.googlequicksearchbox");
  });

  it("is never one of our own sites: the marketing site, its subdomains, or the app itself", () => {
    expect(refererHost("https://altorank.co/pricing/")).toBeUndefined();
    expect(refererHost("https://www.altorank.co/")).toBeUndefined();
    expect(refererHost("https://app.altorank.co/signin")).toBeUndefined();
    // A self-hosted app on its own domain: the request's own Host.
    expect(refererHost("https://seo.example.org/signin", "seo.example.org")).toBeUndefined();
    expect(refererHost("http://localhost:3150/signup?error=x", "localhost:3150")).toBeUndefined();
    // Somebody else's site with our name in it is not ours.
    expect(refererHost("https://notaltorank.co/")).toBe("notaltorank.co");
  });

  it("fills `ref` only when the URL brought none", () => {
    expect(withRefererFallback({}, "https://chatgpt.com/", "app.altorank.co")).toEqual({ ref: "chatgpt.com" });
    expect(withRefererFallback({ src: "/pricing/" }, "https://chatgpt.com/")).toEqual({ src: "/pricing/", ref: "chatgpt.com" });
    expect(withRefererFallback({ ref: "www.google.com" }, "https://chatgpt.com/")).toEqual({ ref: "www.google.com" });
    expect(withRefererFallback({ src: "/" }, "https://app.altorank.co/signin")).toEqual({ src: "/" });
    expect(withRefererFallback({}, null)).toEqual({});
  });
});

describe("recording the source", () => {
  it("records { src, lp, ref, utm } with utm keyed by its short name", () => {
    expect(
      signupSourceContext(parseSignupSource({ src: "/", lp: "/blog/x/", ref: "chatgpt.com", utm_source: "a", utm_medium: "b" })),
    ).toEqual({ src: "/", lp: "/blog/x/", ref: "chatgpt.com", utm: { source: "a", medium: "b" } });
    expect(signupSourceContext({})).toEqual({});
  });

  it("survives the event sanitiser unchanged (no key reads as a secret)", () => {
    const attribution = signupSourceContext(
      parseSignupSource({
        src: "/pricing/",
        lp: "/alternatives/outrank/",
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
    expect(describeSignupSource(parseSignupSource({ src: "/pricing/", lp: "/alternatives/outrank/", ref: "www.google.com" }))).toBe(
      "from /pricing/ (landed on /alternatives/outrank/) via www.google.com",
    );
    // Landed and signed up on the same page: said once.
    expect(describeSignupSource(parseSignupSource({ src: "/", lp: "/" }))).toBe("from /");
    expect(describeSignupSource({})).toBe("source unknown");
  });
});
