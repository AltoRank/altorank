// ---------------------------------------------------------------------------
// docker compose passes every setting the app reads
// ---------------------------------------------------------------------------
//
// A variable set in docker/.env reaches the app only if docker/compose.yml
// names it. deploy.md promised compose "forwards every variable in
// .env.example", and it did not: the public-tools spend cap was documented,
// set by operators, and never reached the container, so the only switch that
// turns the paid anonymous tools off did nothing on Docker. This diffs three
// lists and fails on any gap:
//
// - the keys in docker/.env.example (what an operator is told they can set),
// - the variables compose passes to the `web` service (build args + env),
// - the variables the app's own source reads from process.env.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WEB_DIR = path.resolve(__dirname, "..", "..");
const REPO_DIR = path.resolve(WEB_DIR, "..", "..");

/** Read by the app but deliberately not passed by compose, and why. */
const NOT_FORWARDED: Record<string, string> = {
  NODE_ENV: "set by the Dockerfile",
  E2E_STUBS: "e2e runner only",
  NEXT_PUBLIC_E2E_STUBS: "e2e runner only",
  NEXT_DIST_DIR: "e2e runner only",
  ALLOW_INDEXING_SUBMISSIONS: "development only; production always submits",
  OPENAI_APPS_CHALLENGE_TOKEN: "the hosted app's OpenAI apps domain check",
  SHOPIFY_API_KEY: "the hosted App Store app's client id; a self-hosted install connects a store with its own Dev Dashboard app",
  SHOPIFY_API_SECRET: "the hosted App Store app's client secret; as SHOPIFY_API_KEY",
  VERCEL_PROJECT_PRODUCTION_URL: "set by Vercel itself; next.config.ts uses it to recognise the hosted build",
};
/** PostHog is read at build time and the Docker image is built without analytics. */
const NOT_FORWARDED_PREFIX = "NEXT_PUBLIC_POSTHOG_";

const isExempt = (name: string) => name in NOT_FORWARDED || name.startsWith(NOT_FORWARDED_PREFIX);

function envExampleKeys(): string[] {
  const text = readFileSync(path.join(REPO_DIR, "docker", ".env.example"), "utf8");
  return [...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
}

/** The `web` service's build args and environment keys. */
function composeWeb(): { args: string[]; env: string[]; text: string } {
  const text = readFileSync(path.join(REPO_DIR, "docker", "compose.yml"), "utf8");
  const start = text.indexOf("\n  web:\n");
  const end = text.indexOf("\n  cron:\n");
  if (start === -1 || end === -1) throw new Error("docker/compose.yml: web or cron service not found");
  const web = text.slice(start, end);
  const block = (name: string, indent: string) => {
    const m = web.match(new RegExp(`\\n${indent}${name}:\\n((?:${indent}  .*\\n|\\s*#.*\\n)+)`));
    if (!m) throw new Error(`docker/compose.yml: web.${name} not found`);
    return [...m[1].matchAll(/^\s+([A-Z][A-Z0-9_]*):\s/gm)].map((x) => x[1]);
  };
  return { args: block("args", "      "), env: block("environment", "    "), text: web };
}

const SKIP_DIRS = new Set(["node_modules", ".next", ".next-e2e", ".open-next", "__tests__", "__mocks__", "e2e", "scripts", "supabase", "public"]);

/** Every NAME in `process.env.NAME` / `process.env["NAME"]` / `fromEnv("NAME"` in the app's runtime source. */
function appEnvReads(): string[] {
  const names = new Set<string>();
  const scan = (file: string) => {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) names.add(m[1]);
    for (const m of text.matchAll(/process\.env\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]/g)) names.add(m[1]);
    for (const m of text.matchAll(/fromEnv\(\s*["']([A-Z_][A-Z0-9_]*)["']/g)) names.add(m[1]);
  };
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (/\.(ts|tsx|mjs)$/.test(entry.name) && !/\.(test|spec)\.[jt]sx?$/.test(entry.name)) {
        scan(full);
      }
    }
  };
  for (const dir of ["app", "lib", "components"]) walk(path.join(WEB_DIR, dir));
  for (const entry of readdirSync(WEB_DIR)) {
    if (/^(middleware|proxy|instrumentation.*|next\.config)\.(ts|mjs)$/.test(entry)) scan(path.join(WEB_DIR, entry));
  }
  return [...names].sort();
}

describe("self-host env", () => {
  it("finds the variables it is meant to compare", () => {
    expect(envExampleKeys()).toContain("ANTHROPIC_API_KEY");
    expect(composeWeb().env).toContain("ANTHROPIC_API_KEY");
    expect(composeWeb().args).toContain("NEXT_PUBLIC_SUPABASE_URL");
    expect(appEnvReads()).toContain("PUBLIC_TOOLS_DAILY_CAP_CENTS");
  });

  it("compose passes every variable in .env.example to the web service", () => {
    const { args, env, text } = composeWeb();
    const passed = new Set([...args, ...env]);
    // PORT is used by compose itself, for the port mapping.
    const missing = envExampleKeys().filter((k) => !passed.has(k) && !(k === "PORT" && text.includes("${PORT")));
    expect(missing).toEqual([]);
  });

  it("every variable compose passes is documented in .env.example", () => {
    const documented = new Set(envExampleKeys());
    const { args, env } = composeWeb();
    expect([...args, ...env].filter((k) => !documented.has(k))).toEqual([]);
  });

  it("compose passes every variable the app reads, or the exemption says why not", () => {
    const { args, env } = composeWeb();
    const passed = new Set([...args, ...env]);
    expect(appEnvReads().filter((k) => !passed.has(k) && !isExempt(k))).toEqual([]);
  });

  /**
   * NEXT_PUBLIC_APP_URL is baked into the image. A compose default of
   * localhost built an image whose every emailed link (signup confirmation
   * included) pointed at the reader's own machine, so on a real host nobody
   * could confirm a signup. compose must refuse to build without it, and both
   * "required" lists must name it.
   */
  it("compose refuses to build without NEXT_PUBLIC_APP_URL, and the required lists name it", () => {
    const { text } = composeWeb();
    expect(text).toMatch(/NEXT_PUBLIC_APP_URL: \$\{NEXT_PUBLIC_APP_URL:\?/);
    const example = readFileSync(path.join(REPO_DIR, "docker", ".env.example"), "utf8");
    const requiredBlock = example.slice(0, example.indexOf("# Everything else below is optional"));
    expect(requiredBlock).toContain("NEXT_PUBLIC_APP_URL");
    const readme = readFileSync(path.join(REPO_DIR, "README.md"), "utf8");
    const start = readme.indexOf("Required before a self-hosted install works end to end");
    expect(start).toBeGreaterThan(-1);
    expect(readme.slice(start, readme.indexOf("\n\n", readme.indexOf("\n- ", start) + 1))).toContain("NEXT_PUBLIC_APP_URL");
  });

  it("the exemptions are all still read somewhere", () => {
    const read = new Set(appEnvReads());
    expect(Object.keys(NOT_FORWARDED).filter((k) => !read.has(k))).toEqual([]);
  });
});
