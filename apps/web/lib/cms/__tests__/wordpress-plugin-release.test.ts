import { describe, it, expect, beforeAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { findPluginSourceDir } from "../wordpress-plugin-zip";
import { renderBarChart } from "@/lib/content/enrich/infographic";

// Static checks on the plugin source that hold with or without a PHP binary.
// The behaviour itself is tested in PHP (packages/wordpress-plugin/tests, run
// by wordpress-plugin-php.test.ts where PHP is installed); these pin the
// properties that must never regress even on a machine that skips those.

let dir: string;
const read = (rel: string) => fs.readFile(path.join(dir, rel), "utf8");

/** PHP source without its comments, so a check reads code and not the prose about it. */
const code = (php: string) => php.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** The source of one top-level PHP function, from its signature to the closing brace at column 0. */
function phpFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end + 2);
}

beforeAll(async () => {
  const found = await findPluginSourceDir();
  if (!found) throw new Error("plugin source not found");
  dir = found;
});

describe("REST authentication filter", () => {
  it("decides from the dispatched route, never from the request URL or query string", async () => {
    const api = await read("includes/api.php");
    const body = code(phpFunction(api, "altorank_allow_own_namespace"));
    expect(body).not.toMatch(/\$_SERVER|\$_GET|\$_POST|\$_REQUEST/);
    expect(body).toContain("altorank_dispatched_route()");
    expect(phpFunction(api, "altorank_dispatched_route")).toContain("query_vars['rest_route']");
  });

  it("never clears WordPress's own cookie-nonce error", async () => {
    const api = await read("includes/api.php");
    expect(api).toMatch(/ALTORANK_CORE_AUTH_ERRORS = array\([^)]*'rest_cookie_invalid_nonce'/);
    expect(phpFunction(api, "altorank_allow_own_namespace")).toContain("ALTORANK_CORE_AUTH_ERRORS");
  });

  it("the settings page test sends no session cookie", async () => {
    const settings = await read("includes/settings.php");
    expect(settings).toContain('credentials:"omit"');
  });
});

describe("post writes", () => {
  it("every write of article content goes through the slashed, kses-lifted helper", async () => {
    const api = await read("includes/api.php");
    const upsert = code(phpFunction(api, "altorank_upsert_post"));
    expect(upsert).not.toMatch(/\bwp_(insert|update)_post\(/);
    expect(upsert.match(/altorank_write_post\(/g)?.length).toBe(2);
    const helper = phpFunction(api, "altorank_write_post");
    expect(helper).toContain("wp_slash( $postarr )");
    expect(helper).toContain("kses_remove_filters()");
    expect(helper).toMatch(/finally \{[\s\S]*kses_init_filters\(\)/);
  });
});

describe("edit scope", () => {
  it("/edit only finds posts the plugin created, and never rewrites their external id", async () => {
    const api = await read("includes/api.php");
    const locate = code(phpFunction(api, "altorank_locate_post"));
    expect(locate.match(/altorank_is_own_post\(/g)?.length).toBe(2);
    expect(code(phpFunction(api, "altorank_is_own_post"))).toContain("ALTORANK_META_EXTERNAL_ID");
    expect(code(phpFunction(api, "altorank_upsert_post"))).toContain("if ( $is_new && '' !== $params['external_id'] )");
  });
});

describe("post dates", () => {
  it("dates a post from published_at through the one helper, and never from created_at", async () => {
    const api = code(await read("includes/api.php"));
    expect(api).not.toContain("created_at");
    expect(phpFunction(api, "altorank_upsert_post")).toContain("altorank_post_date_fields( $params['published_at'], ! $post_id, $status )");
  });
});

describe("structured data and charts", () => {
  it("JSON-LD is lifted out of the body before it is sanitised", async () => {
    const upsert = code(phpFunction(await read("includes/api.php"), "altorank_upsert_post"));
    const extract = upsert.indexOf("altorank_extract_structured_data(");
    const sanitise = upsert.indexOf("altorank_sanitize_content(");
    expect(extract).toBeGreaterThan(-1);
    expect(sanitise).toBeGreaterThan(extract);
  });

  it("the body is sanitised with the chart allowlist, not bare wp_kses_post", async () => {
    const sanitise = code(phpFunction(await read("includes/api.php"), "altorank_sanitize_content"));
    expect(sanitise).toContain("wp_kses( $html, altorank_allowed_html() )");
    expect(sanitise).not.toContain("wp_kses_post(");
  });

  it("every element and attribute the dashboard draws a chart with is on the plugin's allowlist", async () => {
    const allowlist = code(phpFunction(await read("includes/api.php"), "altorank_allowed_html"));
    const svg = renderBarChart(
      { unit: "%", data: [{ label: "A", value: 40 }, { label: "B", value: 25 }], source: "A survey" },
      "en",
      "#123456",
    ).match(/<svg[\s\S]*<\/svg>/)![0];
    const elements = new Set([...svg.matchAll(/<([a-zA-Z][\w-]*)/g)].map((m) => m[1].toLowerCase()));
    for (const el of elements) expect(allowlist, `<${el}>`).toContain(`$allowed['${el}']`);
    const attributes = new Set([...svg.matchAll(/\s([a-zA-Z][\w:-]*)=/g)].map((m) => m[1].toLowerCase()));
    for (const attr of attributes) expect(allowlist, attr).toContain(`'${attr}'`);
  });
});
