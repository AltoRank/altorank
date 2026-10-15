// The Agent API help page builds its examples from this install's own origin
// (a key works only against the deployment that issued it), points agents at
// the real skill file, and says where the MCP server is.

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ usePathname: () => "/settings/api-keys/agent-api" }));

import AgentApiPage from "../page";

afterEach(() => vi.unstubAllEnvs());

describe("/settings/api-keys/agent-api", () => {
  it("uses this install's origin in the curl, MCP and CLI examples", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://seo.example.org/");
    const html = renderToStaticMarkup(AgentApiPage());
    expect(html).toContain("https://seo.example.org/api/agent/v1/auth/whoami");
    expect(html).toContain("https://seo.example.org/api/mcp");
    expect(html).toContain("ALTORANK_BASE_URL=https://seo.example.org");
    expect(html).not.toContain("app.altorank.co");
  });

  it("shows a placeholder rather than failing when production has no app URL", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    const html = renderToStaticMarkup(AgentApiPage());
    expect(html).toContain("https://&lt;your-app&gt;/api/mcp");
  });

  it("points agents at skills/altorank/SKILL.md, not the old stub", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://seo.example.org");
    const html = renderToStaticMarkup(AgentApiPage());
    expect(html).toContain("skills/altorank/SKILL.md");
    expect(html).not.toContain("scripts/SKILL.md");
  });
});
