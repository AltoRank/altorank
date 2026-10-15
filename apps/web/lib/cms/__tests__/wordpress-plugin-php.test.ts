import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { findPluginSourceDir } from "../wordpress-plugin-zip";

// The WordPress plugin's own checks, run from the app's unit suite so CI runs
// them too. Both need a PHP binary: GitHub's ubuntu runners have one, and a
// laptop without PHP skips them (the plugin source is still covered by the
// static checks in wordpress-plugin-release.test.ts).

const php = (() => {
  const probe = spawnSync("php", ["-v"], { encoding: "utf8" });
  return probe.status === 0 ? "php" : null;
})();

async function phpFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await phpFiles(abs)));
    else if (entry.name.endsWith(".php")) out.push(abs);
  }
  return out.sort();
}

describe.skipIf(!php)("WordPress plugin under PHP", () => {
  it("every PHP file in the plugin and its tests parses (php -l)", async () => {
    const pluginDir = await findPluginSourceDir();
    expect(pluginDir).not.toBeNull();
    const files = [...(await phpFiles(pluginDir!)), ...(await phpFiles(path.join(pluginDir!, "..", "tests")))];
    expect(files.length).toBeGreaterThan(4);
    for (const file of files) {
      const lint = spawnSync(php!, ["-l", file], { encoding: "utf8" });
      expect(lint.status, `${file}\n${lint.stdout}${lint.stderr}`).toBe(0);
    }
  });

  it("passes its unit tests (packages/wordpress-plugin/tests/run.php)", async () => {
    const pluginDir = await findPluginSourceDir();
    const runner = path.join(pluginDir!, "..", "tests", "run.php");
    const run = spawnSync(php!, [runner], { encoding: "utf8", timeout: 60_000 });
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
    expect(run.stdout).toMatch(/\d+ checks, 0 failed/);
  });
});
