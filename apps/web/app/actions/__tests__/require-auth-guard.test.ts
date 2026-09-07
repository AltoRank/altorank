/**
 * Every exported server action that spends money or changes a row has to
 * establish who is asking before it does anything. RLS is not that check:
 * a `"use server"` export is a public POST endpoint, and an anonymous call
 * with a cookie-less client still reaches the DataForSEO call in seo.ts, the
 * model call in voice.ts and the un-publish in schedule.ts before RLS gets
 * to refuse the row write - by which time the money is spent.
 *
 * Read from the source, like the cron guards: actions are not callable from
 * vitest without a request context, and `await requireAuth()` is one line
 * that a new action is easy to write without.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ACTIONS = join(__dirname, "..");

/** Files whose every export must call requireAuth() (T7 §7, 2026-09-06). */
const GUARDED = ["voice.ts", "seo.ts", "schedule.ts", "audit.ts", "reports.ts", "share.ts"];

function exportedActions(src: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = /export async function (\w+)\(/g;
  let m: RegExpExecArray | null;
  const starts: { name: string; at: number }[] = [];
  while ((m = re.exec(src))) starts.push({ name: m[1], at: m.index });
  starts.forEach((s, i) => {
    const end = starts[i + 1]?.at ?? src.length;
    out.push({ name: s.name, body: src.slice(s.at, end) });
  });
  return out;
}

describe("server actions establish the caller before they spend", () => {
  for (const file of GUARDED) {
    const src = readFileSync(join(ACTIONS, file), "utf8");
    const actions = exportedActions(src);
    it(`${file} exports at least one action`, () => {
      expect(actions.length).toBeGreaterThan(0);
    });
    for (const { name, body } of actions) {
      it(`${file} ${name} calls requireAuth() before its first query`, () => {
        const auth = body.indexOf("requireAuth(");
        expect(auth, `${name} has no requireAuth()`).toBeGreaterThan(-1);
        const firstQuery = body.search(/\.from\(|createClient\(|discoverKeywords\(|checkRankings\(|syncBacklinks\(|analyzeVoice/);
        if (firstQuery > -1) expect(auth).toBeLessThan(firstQuery);
      });
    }
  }
});
