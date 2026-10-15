import { describe, expect, it } from "vitest";
import { sanitizeHtml, sanitizeSvg } from "../sanitize";
import { tiptapToHtml } from "@/lib/cms/html";
import { readableHtml } from "@/lib/onboarding/readable-html";

// Inputs a browser parses differently from a simple tokenizer: namespace
// switches (SVG, MathML), raw-text and RCDATA elements, comments and CDATA,
// repeated and malformed attributes, and references in URLs. Each must come
// back as markup that holds nothing executable.
//
// The output check reads tags structurally. sanitize-html writes every
// attribute double-quoted and escapes every `<`, `>` and `"` in text and
// values, so in its output a literal `<` always starts a real tag; the check
// asserts that before relying on it. Verified once against Chromium as well.

const BLOCKED_TAGS = new Set([
  "script", "style", "object", "embed", "base", "meta", "link", "form", "input", "button", "textarea",
  "select", "foreignobject", "use", "image", "animate", "set", "animatetransform", "animatemotion",
  "discard", "frame", "frameset", "template", "isindex", "applet", "noscript", "xmp", "plaintext",
  "noembed", "noframes", "math",
]);
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "data", "srcdoc", "poster", "background", "xlink:href", "to", "values", "from", "by"]);
const EMBED = /^https:\/\/(www\.)?(youtube-nocookie\.com|youtube\.com)\/embed\//;

function decode(v: string): string {
  return v
    .replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff) || 0xfffd))
    .replace(/&#(\d+);?/g, (_, d: string) => String.fromCodePoint(Math.min(parseInt(d, 10), 0x10ffff) || 0xfffd))
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&colon;/gi, ":").replace(/&tab;|&newline;/gi, "")
    .replace(/&amp;/g, "&");
}

function problems(out: string): string[] {
  const found: string[] = [];
  const tags = [...out.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>"']+(?:="[^"]*")?)*)\s*\/?>/g)];
  if ((out.match(/</g) ?? []).length !== tags.length) found.push("stray <");
  for (const [, closing, rawName, attrs] of tags) {
    if (closing) continue;
    const name = rawName.toLowerCase();
    if (BLOCKED_TAGS.has(name)) found.push(`tag ${name}`);
    for (const [, rawAttr, value = ""] of attrs.matchAll(/([^\s=>"']+)(?:="([^"]*)")?/g)) {
      const attr = rawAttr.toLowerCase();
      if (attr.startsWith("on")) found.push(`handler ${attr}`);
      if (attr === "srcdoc") found.push("srcdoc");
      if (attr === "style" && name !== "svg") found.push(`style on ${name}`);
      if (name === "iframe" && attr === "src" && !EMBED.test(value)) found.push(`iframe ${value}`);
      if (URL_ATTRS.has(attr) || attr.endsWith(":href")) {
        const probe = decode(value).replace(/[\u0000- \u007f-\u009f]/g, "").toLowerCase();
        if (/^(javascript|vbscript|data):/.test(probe)) found.push(`${attr}=${value}`);
      }
    }
  }
  return found;
}

const J = "javascript:alert(1)";
const IMG = "<img src=x onerror=alert(1)>";

const NAMESPACE_AND_RAWTEXT = [
  `<svg></p><style><a id="</style>${IMG}">`,
  `<svg><p><style><a id="</style>${IMG}">`,
  `<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;/mglyph&gt;&lt;img&Tab;src=1&Tab;onerror=alert(1)&gt;">`,
  `<form><math><mtext></form><form><mglyph><svg><mtext><style><path id="</style><img onerror=alert(1) src>">`,
  `<math><mi><svg><style>${IMG}`,
  `<noscript><p title="</noscript>${IMG}">`,
  `<iframe src="https://www.youtube.com/embed/x"><a title="</iframe>${IMG}"></a></iframe>`,
  `<iframe src="https://www.youtube.com/embed/x"></iframe >${IMG}`,
  `<iframe src="https://www.youtube.com/embed/x" srcdoc="<script>alert(1)</script>" onload="alert(1)"></iframe>`,
  `<iframe src="https://www.youtube.com.evil.example/embed/x"></iframe>`,
  `<svg><iframe src="https://www.youtube.com/embed/x"><a title="</iframe>${IMG}"></a></iframe></svg>`,
  `<title>${IMG}</title>`,
  `<svg><title>${IMG}</title></svg>`,
  `<svg><title></title><p><title><a title="</title>${IMG}">`,
  `<svg><desc>${IMG}</desc></svg>`,
  `<p><svg><title><p></title>${IMG}</svg></p>`,
  `<svg><desc><title><style><a id="</style>${IMG}"></style></title></desc></svg>`,
  `<svg><![CDATA[</svg>${IMG}]]></svg>`,
  `<svg><style><![CDATA[</style>${IMG}]]></style></svg>`,
  `<select><template><style><!--</style><a rel="--></style></template></select>${IMG}">`,
  `<textarea><img title="</textarea>${IMG}"></textarea>`,
  `<xmp><p title="</xmp>${IMG}"></xmp>`,
  `<noembed><p title="</noembed>${IMG}"></noembed>`,
  `<noframes><p title="</noframes>${IMG}"></noframes>`,
  `<plaintext>${IMG}`,
  `<!--->${IMG}-->`,
  `<!--!>${IMG}-->`,
  `<!-- --!>${IMG}-->`,
  `<?xml ?>${IMG}`,
  `${"<div>".repeat(120)}${IMG}${"</div>".repeat(120)}`,
  `${"<svg>".repeat(80)}<a href="${J}">x</a>`,
];

const SVG_REFERENCES_AND_ANIMATION = [
  `<svg><a xlink:href="${J}"><text y=20>x</text></a></svg>`,
  `<svg><a href="${J}"><rect width=100 height=100 /></a></svg>`,
  `<svg><a href="javascript&colon;alert(1)"><rect width=100 height=100 /></a></svg>`,
  `<svg><set attributeName="href" to="${J}"/></svg>`,
  `<svg><a><animate attributeName=href values=${J} /><text x=20 y=20>Click</text></a></svg>`,
  `<svg><discard onbegin=alert(1)></svg>`,
  `<svg><image href=x onerror=alert(1)></svg>`,
  `<svg><g/onload=alert(1)//<p>`,
  `<svg><foreignobject><iframe src=${J}></iframe></foreignobject></svg>`,
  `<svg><script href=data:,alert(1) /></svg>`,
  `<svg style="font-family:x;background:url(${J})"><rect width="1"/></svg>`,
  `<svg style="max-width:1px;}</style>${IMG}"><rect width="1"/></svg>`,
  `<svg><text font-family="x</text>${IMG}">t</text></svg>`,
  `<svg><rect fill="url(#x)" stroke="url(${J})" width="1"/></svg>`,
  `<svg><text aria-label='">${IMG}'>t</text></svg>`,
  `<svg><use href="data:image/svg+xml,<svg id=x onload=alert(1)>"/></svg>`,
  `<SVG><SCRIPT>alert(1)</SCRIPT></SVG>`,
];

const ATTRIBUTES_AND_URLS = [
  `<img src=x onerror=alert(1)//`,
  `<img """><script>alert(1)</script>">`,
  "<img src=\"x` onerror=alert(1)>",
  `<img src="https://ok.example/x.png" alt="&quot; onerror=&quot;alert(1)">`,
  `<img src="x" onerror\u000b=alert(1)>`,
  `<img src=x on\u0000error=alert(1)>`,
  `<a href="&#x6A;&#x61;&#x76;&#x61;&#x73;&#x63;&#x72;&#x69;&#x70;&#x74;&#x3A;alert(1)">x</a>`,
  `<a href="&#0000106&#0000097&#0000118&#0000097&#0000115&#0000099&#0000114&#0000105&#0000112&#0000116&#0000058alert(1)">x</a>`,
  `<a href="javascript&#000000058;alert(1)">x</a>`,
  `<a href="javascript&#x00000003a;alert(1)">x</a>`,
  `<a href="java&#x0A;script:alert(1)">x</a>`,
  `<a href="java&NewLine;script:alert(1)">x</a>`,
  `<a href="\u0001javascript:alert(1)">x</a>`,
  `<a href=" &#14;  javascript:alert(1)">x</a>`,
  `<a href="ja\u0000vascript:alert(1)">x</a>`,
  `<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>`,
  `<a href="https://ok.example" onclick="alert(1)" o\nnmouseover="alert(1)">x</a>`,
  `<a href="${J}" href="https://ok.example">x</a>`,
  `<q cite="${J}">x</q><blockquote cite="${J}">y</blockquote>`,
  `<isindex action=${J} type=image>`,
  `<input onfocus=alert(1) autofocus><video><source onerror=alert(1)></video><audio src=x onerror=alert(1)>`,
  `<marquee onstart=alert(1)>x</marquee><details open ontoggle=alert(1)>x</details>`,
  `<link rel=stylesheet href=https://evil.example/x.css><meta http-equiv=refresh content="0;url=${J}"><base href="https://evil.example/">`,
  `<object data="${J}"></object><embed src="${J}"><form action="${J}"><button formaction="${J}">go</button></form>`,
  `<abbr title="</abbr><script>alert(1)</script>">a</abbr><time datetime='">${IMG}'>t</time>`,
];

describe("sanitizeHtml: parser-differential inputs", () => {
  const all = [...NAMESPACE_AND_RAWTEXT, ...SVG_REFERENCES_AND_ANIMATION, ...ATTRIBUTES_AND_URLS];

  it("namespace switches, raw-text elements, comments and CDATA come back inert", () => {
    for (const input of NAMESPACE_AND_RAWTEXT) expect(problems(sanitizeHtml(input)), input).toEqual([]);
  });

  it("SVG references, animation and styles come back inert", () => {
    for (const input of SVG_REFERENCES_AND_ANIMATION) expect(problems(sanitizeHtml(input)), input).toEqual([]);
  });

  it("malformed attributes and encoded URLs come back inert", () => {
    for (const input of ATTRIBUTES_AND_URLS) expect(problems(sanitizeHtml(input)), input).toEqual([]);
  });

  it("inline figures from the same inputs are inert or refused", () => {
    for (const input of all.filter((p) => /^<svg/i.test(p))) {
      const svg = sanitizeSvg(input);
      if (svg !== null) expect(problems(svg), input).toEqual([]);
      expect(problems(tiptapToHtml({ type: "doc", content: [{ type: "svgFigure", attrs: { svg: input } }] })), input).toEqual([]);
    }
  });

  it("the onboarding reader rebuilds the same inputs inert", () => {
    for (const input of all) expect(problems(readableHtml(input)), input).toEqual([]);
  });
});
