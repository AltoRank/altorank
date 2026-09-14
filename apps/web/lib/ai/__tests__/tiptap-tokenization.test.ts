import { expect, it } from "vitest";
import { DomUtils, parseDocument } from "htmlparser2";
import { htmlToTiptapJson } from "../tiptap";
import { tiptapToHtml } from "@/lib/cms/html";

const saved = (html: string) => tiptapToHtml(htmlToTiptapJson(html) as unknown as Record<string, unknown>);
const visible = (html: string) => DomUtils.textContent(parseDocument(html)).trim();

it.each(['title="A > B"', "title='A > B'", 'title="A >\nB"'])
("does not turn quoted attribute text into article prose: %s", attribute => {
  const html = saved(`<p ${attribute}>Approval is required.</p>`);
  expect(visible(html)).toBe("Approval is required.");
  expect(html).toBe("<p>Approval is required.</p>");
});

it("keeps a multiline citation URL intact and decodes its attribute entities once", () => {
  const source = '<p>Read <a\n href="https://example.test/pricing?plan=free&amp;limit=10"\n title="A > B">pricing</a> first.</p>';
  const document = htmlToTiptapJson(source);
  expect(document.content[0].content?.[1].marks?.[0]).toMatchObject({
    type: "link", attrs: { href: "https://example.test/pricing?plan=free&limit=10" },
  });
  const html = tiptapToHtml(document as unknown as Record<string, unknown>);
  expect(html).toContain('href="https://example.test/pricing?plan=free&amp;limit=10"');
  expect(html).not.toContain("&amp;amp;");
  expect(visible(html)).toBe("Read pricing first.");
});

it("treats entity-encoded quotes as attribute data, never as new attributes", () => {
  const source = '<img src="/figure.png" alt="A > B &quot; onerror=&quot;alert(1) &amp; C" title="&#8364;50" />';
  const document = htmlToTiptapJson(source);
  expect(document.content[0].attrs).toMatchObject({
    alt: 'A > B " onerror="alert(1) & C', title: "€50",
  });
  const html = tiptapToHtml(document as unknown as Record<string, unknown>);
  const image = DomUtils.findOne(element => element.name === "img", parseDocument(html).children);
  expect(image?.attribs.alt).toBe('A > B " onerror="alert(1) & C');
  expect(image?.attribs).not.toHaveProperty("onerror");
  expect(visible(html)).toBe("");
});

it("preserves literal entity examples in attribute values after rendering", () => {
  const html = saved('<img src="/figure.png" alt="Write &amp;lt; literally &amp; keep &#8364;50" />');
  const image = DomUtils.findOne(element => element.name === "img", parseDocument(html).children);
  expect(image?.attribs.alt).toBe("Write &lt; literally & keep €50");
});

it.each(["&#106;avascript&colon;alert(1)", "java&#x09;script&#58;alert(1)", "data&colon;text/html,hello"])
("does not activate a decoded unsafe URL: %s", url => {
  const html = saved(`<p><a href="${url}">Keep this text.</a></p><img src="${url}" alt="Unsafe image" />`);
  expect(visible(html)).toBe("Keep this text.");
  expect(html).not.toContain("<a ");
  expect(html).not.toContain("<img ");
});

it("preserves numeric and named HTML entities as their visible text", () => {
  const html = saved("<p>&#8364;50; &#x20AC;75; &eacute;quipe; &NotEqualTilde;; &#x1F4C5;.</p>");
  expect(visible(html)).toBe("€50; €75; équipe; ≂̸; 📅.");
  expect(html).not.toContain("&amp;#");
});

it("decodes text once without turning escaped entity or tag examples into markup", () => {
  const html = saved("<p>Write &amp;#8364; or &amp;lt;strong&amp;gt; literally.</p>");
  expect(visible(html)).toBe("Write &#8364; or &lt;strong&gt; literally.");
  expect(html).not.toContain("<strong>");
});

it("keeps scripts and styles inert while retaining visible article text", () => {
  const html = saved('<script>if (a > b) { document.write("injected prose"); }</script><style>.x::before { content: "style prose >"; }</style><p>Visible article text.</p>');
  expect(visible(html)).toBe("Visible article text.");
  expect(html).not.toContain("injected prose");
  expect(html).not.toContain("style prose");
});
