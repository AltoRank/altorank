import { expect, it } from "vitest";
import { htmlToTiptapJson } from "../tiptap";
import { tiptapToHtml } from "@/lib/cms/html";
const saved=(html:string)=>tiptapToHtml(htmlToTiptapJson(html) as unknown as Record<string,unknown>);
it("preserves a nested paragraph qualifying the preceding table-cell claim",()=>{
  const html=saved("<table><tr><td>Exports available.<p>Only after administrator approval.</p></td></tr></table>");
  expect(html).toContain("<td><p>Exports available.</p>\n<p>Only after administrator approval.</p>");
});
it("keeps complete paragraphs in list items and table cells",()=>{
  const html=saved("<ol><li><p>Select a service.</p></li><li><p>Confirm the booking.</p></li></ol><table><tr><th><p>Plan</p></th><td><p>Approval required.</p></td></tr></table>");
  for(const text of ["Select a service.","Confirm the booking.","Plan","Approval required."])expect(html).toContain(text);
  expect(html).not.toContain("<p></p>");
});
it("preserves nesting, subsequent instructions, emphasis and citations",()=>{
  const html=saved('<ol><li>Select a <strong>service</strong>.<ul><li>Check the <a href="https://example.test/terms">conditions</a>.</li></ul>Then select a time.</li><li>Confirm the booking.</li></ol>');
  expect(html).toContain("<strong>service</strong>");
  expect(html).toContain("<ul>");
  expect(html).toContain('href="https://example.test/terms"');
  expect(html).toContain("Then select a time.");
  expect(html.indexOf("Then select a time.")).toBeLessThan(html.indexOf("Confirm the booking."));
  expect((html.match(/<li>/g)??[]).length).toBe(3);
});
