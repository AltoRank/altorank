import { describe, it, expect, beforeAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { findPluginSourceDir } from "../wordpress-plugin-zip";

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
