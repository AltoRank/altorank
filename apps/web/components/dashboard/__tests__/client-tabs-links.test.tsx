import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// renderToStaticMarkup, as the other dashboard panels are tested: no jsdom here.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));

import { ClientTabs } from "../client-tabs";
import type { Article, Workspace } from "@/lib/types";

const workspace = { id: "ws-1", name: "Acme", domain: "acme.com", status: "on", auto_generate: true } as unknown as Workspace;
const article = (id: string, title: string) =>
  ({ id, title, keyword: "kw", status: "review", seo_score: 70, workspace_id: "ws-1", updated_at: null }) as unknown as Article;

describe("the workspace page's article tables", () => {
  it("open each article: its title links to the editor", () => {
    const html = renderToStaticMarkup(
      <ClientTabs
        workspace={workspace}
        articles={[article("a1", "First draft"), article("a2", "Second draft")]}
        keywords={[]}
        calendar={[]}
        backlinks={[]}
        hasDestination={false}
        voice={null}
        cadence={null}
        planIncluded={null}
        maxPace={7}
        now={0}
      />,
    );
    expect(html).toMatch(/<a[^>]*href="\/content\/a1"[^>]*>First draft<\/a>/);
    expect(html).toMatch(/<a[^>]*href="\/content\/a2"[^>]*>Second draft<\/a>/);
  });
});
