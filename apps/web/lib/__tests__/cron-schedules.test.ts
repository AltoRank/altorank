// ---------------------------------------------------------------------------
// Every scheduler runs every cron job
// ---------------------------------------------------------------------------
//
// The cron routes are called by four schedulers that live in four files:
// vercel.json (hosted), docker/crontab (Docker self-host), and wrangler.jsonc
// plus cloudflare/worker.mjs (Cloudflare). They drifted once already: three
// jobs (refresh, site-pages, ops-digest) were added to vercel.json and never
// reached the other two, so a self-hosted Refresh toggle saved a setting that
// nothing ever acted on. This reads all of them and the route directories and
// fails when they disagree about which jobs exist.
//
// Schedules may differ on purpose: the hosted plan allows each cron at most
// once a day, the self-host schedulers do not, so publish, analyze and
// generate run more often off Vercel. Every other job runs on the same
// schedule everywhere.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WEB_DIR = path.resolve(__dirname, "..", "..");
const REPO_DIR = path.resolve(WEB_DIR, "..", "..");

const read = (...parts: string[]) => readFileSync(path.join(...parts), "utf8");

/** Route directories under app/api/cron, i.e. the jobs that exist. */
function cronRoutes(): string[] {
  return readdirSync(path.join(WEB_DIR, "app", "api", "cron"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("__"))
    .map((d) => d.name)
    .sort();
}

const jobOf = (route: string) => route.replace(/^\/api\/cron\//, "");

function vercelSchedules(): Map<string, string> {
  const json = JSON.parse(read(WEB_DIR, "vercel.json")) as { crons: { path: string; schedule: string }[] };
  return new Map(json.crons.map((c) => [jobOf(c.path), c.schedule]));
}

function crontabSchedules(): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of read(REPO_DIR, "docker", "crontab").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+altorank-cron\s+(\S+)$/);
    if (!m) throw new Error(`docker/crontab: cannot read line ${JSON.stringify(line)}`);
    out.set(m[2], m[1]);
  }
  return out;
}

function wranglerTriggers(): string[] {
  // JSONC: drop whole-line comments, then parse.
  const text = read(WEB_DIR, "wrangler.jsonc")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  const json = JSON.parse(text) as { triggers: { crons: string[] } };
  return json.triggers.crons;
}

function workerRoutes(): Map<string, string> {
  const text = read(WEB_DIR, "cloudflare", "worker.mjs");
  const block = text.match(/const CRON_ROUTES = \{([\s\S]*?)\};/);
  if (!block) throw new Error("cloudflare/worker.mjs: CRON_ROUTES not found");
  const out = new Map<string, string>();
  for (const m of block[1].matchAll(/"([^"]+)":\s*"([^"]+)"/g)) out.set(jobOf(m[2]), m[1]);
  return out;
}

/** Jobs whose self-host schedule is deliberately more frequent than vercel.json's. */
const MORE_FREQUENT_OFF_VERCEL = new Set(["publish", "analyze", "generate"]);

describe("cron schedules", () => {
  it("finds the cron routes", () => {
    expect(cronRoutes()).toContain("publish");
    expect(cronRoutes().length).toBeGreaterThanOrEqual(12);
  });

  it("vercel.json schedules every cron route", () => {
    expect([...vercelSchedules().keys()].sort()).toEqual(cronRoutes());
  });

  it("docker/crontab schedules every cron route", () => {
    expect([...crontabSchedules().keys()].sort()).toEqual(cronRoutes());
  });

  it("cloudflare/worker.mjs maps every cron route", () => {
    expect([...workerRoutes().keys()].sort()).toEqual(cronRoutes());
  });

  it("wrangler.jsonc triggers exactly the expressions worker.mjs maps", () => {
    const triggers = wranglerTriggers();
    expect(new Set(triggers).size).toBe(triggers.length);
    expect([...triggers].sort()).toEqual([...workerRoutes().values()].sort());
  });

  it("Docker and Cloudflare run each job on the same schedule", () => {
    const crontab = crontabSchedules();
    for (const [job, schedule] of workerRoutes()) expect([job, schedule]).toEqual([job, crontab.get(job)]);
  });

  it("only publish, analyze and generate differ from vercel.json", () => {
    const vercel = vercelSchedules();
    for (const [job, schedule] of crontabSchedules()) {
      if (MORE_FREQUENT_OFF_VERCEL.has(job)) continue;
      expect([job, schedule]).toEqual([job, vercel.get(job)]);
    }
  });

  it("self-host generate runs at the hours hosted gets from Vercel plus the GitHub workflow", () => {
    const hours = (expr: string) => expr.split(/\s+/)[1].split(",").map(Number);
    const workflow = read(REPO_DIR, ".github", "workflows", "generate-cron.yml").match(/cron:\s*"([^"]+)"/);
    if (!workflow) throw new Error("generate-cron.yml: no cron expression");
    const hosted = [...hours(vercelSchedules().get("generate")!), ...hours(workflow[1])].sort((a, b) => a - b);
    expect(hours(crontabSchedules().get("generate")!)).toEqual(hosted);
  });

  it("self-host publish runs more than once an hour", () => {
    expect(crontabSchedules().get("publish")).toMatch(/^\*\/(5|10|15|20|30) \* \* \* \*$/);
  });
});
