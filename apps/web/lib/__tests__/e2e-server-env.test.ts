// `npm run dev:e2e` and the server playwright starts must be the same server.
// dev:e2e used to set only E2E_STUBS, so a server left running for the runner
// to reuse kept every paid key from the env files.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { E2E_PORT, E2E_SERVER_ENV } from "../../e2e/fixtures/server-env";

const WEB_DIR = path.resolve(__dirname, "..", "..");
const read = (f: string) => readFileSync(path.join(WEB_DIR, f), "utf8");

describe("e2e dev server environment", () => {
  it("blanks every paid key and turns the stubs on", () => {
    expect(E2E_SERVER_ENV.E2E_STUBS).toBe("1");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DATAFORSEO_API_KEY", "DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD", "STRIPE_SECRET_KEY"]) {
      expect(E2E_SERVER_ENV[k], k).toBe("");
    }
    expect(E2E_SERVER_ENV.NEXT_PUBLIC_APP_URL).toBe(`http://localhost:${E2E_PORT}`);
  });

  it("npm run dev:e2e starts the shared script, and the script uses the shared env", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["dev:e2e"]).toBe("tsx scripts/dev-e2e.ts");
    const script = read("scripts/dev-e2e.ts");
    expect(script).toContain("E2E_SERVER_ENV");
    expect(script).toContain("E2E_PORT");
  });

  it("playwright starts its server with the same env and port", () => {
    const config = read("playwright.config.ts");
    expect(config).toContain("...E2E_SERVER_ENV");
    expect(config).toContain("next dev -p ${E2E_PORT}");
  });
});
