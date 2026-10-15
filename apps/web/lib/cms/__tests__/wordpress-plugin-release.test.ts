import { describe, it, expect, beforeAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { findPluginSourceDir, readPluginVersion } from "../wordpress-plugin-zip";
import { compareVersions, MIN_PLUGIN_VERSION } from "../wordpress-plugin-install";
import { GET } from "@/app/api/public/wordpress-plugin/route";
import { renderBarChart } from "@/lib/content/enrich/infographic";

// Static checks on the plugin source that hold with or without a PHP binary.
// The behaviour itself is tested in PHP (packages/wordpress-plugin/tests, run
// with php -l by CI's "WordPress plugin" step); these pin the properties that
// must never regress, on every machine that runs the unit tier.

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

  it("embed placeholders carry a per-call random token, so body text cannot name one", async () => {
    const sanitise = code(phpFunction(await read("includes/api.php"), "altorank_sanitize_content"));
    expect(sanitise).toMatch(/\$nonce = bin2hex\( random_bytes\( \d+ \) \);/);
    expect(sanitise).toContain("'[altorank-embed-' . $nonce . '-' . count( $kept ) . ']'");
    expect(sanitise).not.toMatch(/'\[altorank-embed-' \. count\(/);
  });

  it("an embed's host is checked on the URL as printed, http(s) only", async () => {
    const sanitise = code(phpFunction(await read("includes/api.php"), "altorank_sanitize_content"));
    const escaped = sanitise.indexOf("esc_url( $src[1], array( 'https', 'http' ) )");
    expect(escaped).toBeGreaterThan(-1);
    expect(sanitise.indexOf("PHP_URL_HOST")).toBeGreaterThan(escaped);
  });

  it("the media import takes raster images only", async () => {
    const map = code(phpFunction(await read("includes/api.php"), "altorank_extension_for_mime"));
    expect(map).not.toContain("svg");
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

/** One file's bytes out of a zip, found through the central directory. */
function zipFile(buf: Buffer, name: string): Buffer | null {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = buf.readUInt16LE(eocd + 10); n > 0; n--) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const skip = nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    if (buf.subarray(p + 46, p + 46 + nameLen).toString("utf8") === name) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const body = buf.subarray(start, start + csize);
      return method === 8 ? inflateRawSync(body) : Buffer.from(body);
    }
    p += 46 + skip;
  }
  return null;
}

describe("release 1.1.1", () => {
  it("names one version everywhere: header, constant, Stable tag, top changelog entry", async () => {
    const main = await read("altorank.php");
    const readme = await read("readme.txt");
    const version = await readPluginVersion(dir);
    expect(version).toBe("1.1.1");
    expect(main).toContain(`define( 'ALTORANK_VERSION', '${version}' );`);
    expect(/^Stable tag:\s*(\S+)/m.exec(readme)?.[1]).toBe(version);
    expect(/== Changelog ==\s*= ([^ ]+) =/.exec(readme)?.[1]).toBe(version);
    expect(/== Upgrade Notice ==\s*= ([^ ]+) =/.exec(readme)?.[1]).toBe(version);
  });

  it("carries an Update URI that is not wordpress.org, so a listing under the same slug is never offered", async () => {
    const uri = /^\s*\*\s*Update URI:\s*(\S+)/m.exec(await read("altorank.php"))?.[1];
    expect(uri).toBeTruthy();
    const host = new URL(uri!).hostname;
    expect(["w.org", "wordpress.org"]).not.toContain(host);
    expect(host.endsWith("altorank.co")).toBe(true);
  });

  it("the dashboard never requires a plugin newer than the one it serves", async () => {
    const shipped = (await readPluginVersion(dir))!;
    expect(compareVersions(MIN_PLUGIN_VERSION, shipped)).toBeLessThanOrEqual(0);
    expect(compareVersions(MIN_PLUGIN_VERSION, "1.1.1")).toBeGreaterThanOrEqual(0);
  });

  it("GET /api/public/wordpress-plugin serves this source as 1.1.1", async () => {
    const res = await GET();
    expect(res.headers.get("x-plugin-version")).toBe("1.1.1");
    const zip = Buffer.from(await res.arrayBuffer());
    for (const rel of ["altorank.php", "readme.txt", "includes/api.php", "includes/settings.php", "uninstall.php"]) {
      expect(zipFile(zip, `altorank/${rel}`)?.toString("utf8"), rel).toBe(await read(rel));
    }
    // The test harness lives beside the plugin, not in what customers install.
    expect(zipFile(zip, "altorank/tests/run.php")).toBeNull();
  });
});
