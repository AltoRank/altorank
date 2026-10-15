import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/app/actions/linking", () => ({
  addLinkSource: async () => ({}),
  removeLinkSource: async () => {},
  runLinkDetection: async () => ({}),
  setLinkSourceEnabled: async () => {},
  updateLinkTarget: async () => {},
}));

import { LinkingConfig } from "../linking/linking-config";
import type { LinkSourceRow } from "@/lib/linking/detect";

const source = (id: string, kind: LinkSourceRow["kind"], url: string) =>
  ({ id, workspace_id: "ws", kind, url, enabled: true, last_detected_at: null, pages_found: null, error: null, created_at: "" }) as LinkSourceRow;

describe("/linking sources", () => {
  it("offers Remove only on sources that stay removed", () => {
    const html = renderToStaticMarkup(
      <LinkingConfig
        workspaceId="ws"
        sources={[source("s1", "sitemap", "https://acme.com/sitemap.xml"), source("s2", "manual_url", "https://acme.com/page")]}
        targets={[]}
        defaults={{ sitemap_url: "https://acme.com/sitemap.xml", blog_root_url: null }}
      />,
    );
    expect(html.match(/title="Remove source"/g)).toHaveLength(1);
    expect(html).toContain("Switch it off to stop reading it.");
  });

  it("calls the top priority Highest: it ranks first, it does not force a link", () => {
    const html = renderToStaticMarkup(
      <LinkingConfig
        workspaceId="ws"
        sources={[]}
        targets={[{ id: "t1", url: "https://acme.com/a", path: "/a", title: "A", keyword: "a", priority: 3, anchors: [], source: "detected", enabled: true, site_page_id: null }]}
      />,
    );
    expect(html).toContain("Highest");
    expect(html).not.toMatch(/>Always</);
  });
});
