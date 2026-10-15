// Only the hosted app sends its root and marketing paths to altorank.co. A
// self-hosted install's root used to answer a permanent redirect to the
// vendor's marketing site, and its Docker healthcheck followed it.

import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../../next.config";

afterEach(() => vi.unstubAllEnvs());

async function redirects(appUrl: string) {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", appUrl);
  return nextConfig.redirects!();
}

describe("next.config redirects", () => {
  it("hosted: the root and marketing paths go to the marketing site, except an auth code on the root", async () => {
    const list = await redirects("https://app.altorank.co");
    const root = list.find((r) => r.source === "/");
    expect(root).toMatchObject({ destination: "https://altorank.co", permanent: true, missing: [{ type: "query", key: "code" }] });
    expect(list.find((r) => r.source === "/pricing")?.destination).toBe("https://altorank.co/pricing");
  });

  it.each(["http://localhost:3000", "https://seo.example.org", ""])("any other install (%s): root goes to the dashboard, nothing leaves the install", async (url) => {
    const list = await redirects(url);
    const root = list.find((r) => r.source === "/");
    expect(root).toMatchObject({ destination: "/dashboard", permanent: false, missing: [{ type: "query", key: "code" }] });
    expect(list.filter((r) => /^https?:/.test(r.destination))).toEqual([]);
    expect(list.find((r) => r.source === "/clients")?.destination).toBe("/workspaces");
  });
});
