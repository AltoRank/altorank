import type { Metadata } from "next";
import { PageHead, Card } from "@/components/ui";
import { SettingsTabs } from "../../settings-tabs";

export const metadata: Metadata = { title: "Agent API" };

/**
 * Every endpoint, and whether it needs a write key.
 *
 * The table used to list eleven of twenty-three: everything behind "Allow
 * edits" was missing, including the one call that reaches a CMS. A person
 * deciding what to hand an agent has to be able to read the whole surface
 * here (2026-09-06).
 */
const ENDPOINTS: [string, string, string][] = [
  ["GET", "/api/agent/v1/auth/whoami", "Who this key is: account, workspaces, quota."],
  ["GET", "/api/agent/v1/workspaces", "Every workspace in the account."],
  ["GET", "/api/agent/v1/workspaces/{id}", "One workspace, with integration status and a human-readable summary."],
  ["GET", "/api/agent/v1/keywords?workspace_id=", "Tracked keywords for a workspace."],
  ["GET", "/api/agent/v1/keywords/export?workspace_id=", "Every tracked keyword as CSV or JSON."],
  ["POST", "/api/agent/v1/keywords/suggest", "Keyword candidates for a workspace (costs research credits; nothing is saved)."],
  ["GET", "/api/agent/v1/articles?workspace_id=", "Articles for a workspace, each with editor_url and allowed_mutations."],
  ["GET", "/api/agent/v1/articles/{id}", "One article and its latest generation job."],
  ["GET", "/api/agent/v1/articles/{id}/content", "The body as Markdown, HTML or Tiptap JSON."],
  ["POST", "/api/agent/v1/articles/generate", "Write a draft into the review queue. Returns immediately; poll the article."],
  ["GET", "/api/agent/v1/readiness?workspace_id=", "The agent-readiness report for a workspace."],
  ["GET", "/api/agent/v1/usage", "This month's quota and per-workspace article counts."],
  ["GET", "/api/agent/v1/gsc/performance?workspace_id=", "Search Console clicks and impressions for a window, against the one before."],
  ["GET", "/api/agent/v1/gsc/coverage?workspace_id=", "Index coverage per page, bucketed."],
  ["GET", "/api/agent/v1/gsc/cannibalization?workspace_id=", "Queries where two or more of the site's pages compete."],
  ["GET", "/api/agent/v1/gsc/url-inspection?workspace_id=&url=", "What Google last said about one URL."],
];

/** The writes, gated on a key created with "Allow edits". */
const WRITE_ENDPOINTS: [string, string, string][] = [
  ["POST", "/api/agent/v1/articles/{id}/replace", "Find-and-replace inside one draft. Preview by default."],
  ["POST", "/api/agent/v1/articles/bulk-replace", "The same, across up to ten drafts. Preview by default."],
  ["POST", "/api/agent/v1/articles/{id}/retry-publish", "Re-run the last failed publish of an article a person already approved. The one call that reaches a CMS."],
  ["POST", "/api/agent/v1/keywords/bulk-remove", "Take planned keywords off the calendar."],
  ["POST", "/api/agent/v1/keywords/bulk-reschedule", "Move planned keywords to other days."],
  ["POST", "/api/agent/v1/workspaces/{id}/pause", "Stop writing and publishing for one workspace."],
  ["POST", "/api/agent/v1/workspaces/{id}/resume", "Put a paused workspace back and re-plan its calendar."],
];

const CODE = "font-mono text-[11.5px] bg-panel border border-line rounded-md px-3 py-2 overflow-x-auto whitespace-pre";

/**
 * The short version of scripts/SKILL.md, for a person deciding whether to hand
 * an agent a key. The full skill file is what the agent itself reads.
 */
export default function AgentApiPage() {
  return (
    <>
      <PageHead title="Agent API" subtitle="What a coding agent can do with an API key, and what it cannot." backHref="/settings/api-keys" backLabel="API keys" />
      <SettingsTabs />

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll">
        <div className="max-w-[860px] space-y-5 text-[13px] text-ink-2">
          <Card title="The one rule">
            {/* The absolute version of this - "There is no endpoint for any of
                those, so an agent cannot be talked into them" - was false:
                POST /articles/{id}/retry-publish reaches a CMS. The endpoint
                is genuinely narrow, which is why the honest sentence is easy
                to write and the absolute one was indefensible (2026-09-06). */}
            <p>
              An agent can read everything in the account and write <b>drafts</b>. It cannot approve,
              schedule, publish a new post, or delete anything: there is no endpoint for any of those.
              Every draft lands in the review queue with a link to the editor, and a person decides
              what ships.
            </p>
            <p className="mt-3">
              One call reaches a CMS, and only with a key created with <b>Allow edits</b>:{" "}
              <span className="font-mono text-[11.5px]">POST /articles/{"{id}"}/retry-publish</span>{" "}
              re-runs a publish that a person already approved and that already failed. It refuses an
              article in draft or review, refuses one with no failed attempt behind it, and refuses an
              account with no plan. It cannot choose a different destination and it cannot create a
              post that was never approved.
            </p>
          </Card>

          <Card title="Authentication">
            <p className="mb-3">
              Create a key on the API keys page and send it as a bearer token. Keys are stored hashed;
              a revoked or expired key answers 401 with instructions for the agent.
            </p>
            <pre className={CODE}>{`curl -H "Authorization: Bearer $ALTORANK_API_KEY" \\
  https://app.altorank.co/api/agent/v1/auth/whoami`}</pre>
            {/* Two windows, not one. lib/agent/http.ts puts a second, tighter
                limiter on mutations, so an agent doing writes is refused at 30
                while the page claimed 120 (2026-09-06). */}
            <p className="mt-3 text-ink-3">
              120 requests a minute per key, and a second, tighter window on writes: 30 a minute per
              key. Both are reported in X-RateLimit-* headers.
            </p>
          </Card>

          <Card title="Every response has the same shape">
            <pre className={CODE}>{`{ "ok": true,  "data": { … }, "agent_guidance": "What to do next." }
{ "ok": false, "error": { "code": "unauthorized", "message": "…" },
               "agent_guidance": "How to fix it." }`}</pre>
            <p className="mt-3">
              <b>agent_guidance</b> is a sentence for the agent. Articles and keywords also carry
              <b> allowed_mutations</b>, so the agent knows before trying that a published article
              cannot be regenerated, and <b>editor_url</b>, so it can hand a person the right link.
            </p>
          </Card>

          <Card title="Endpoints" flush>
            <table className="w-full border-collapse text-[12.5px]">
              <tbody>
                {ENDPOINTS.map(([method, path, what]) => (
                  <tr key={path} className="border-b border-line-soft last:border-0">
                    <td className="px-4 py-2.5 font-mono text-[11px] text-ink-3 w-[52px]">{method}</td>
                    <td className="px-2 py-2.5 font-mono text-[11.5px] whitespace-nowrap">{path}</td>
                    <td className="px-4 py-2.5 text-ink-2">{what}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card title="Endpoints a key with Allow edits can also call" flush>
            <table className="w-full border-collapse text-[12.5px]">
              <tbody>
                {WRITE_ENDPOINTS.map(([method, path, what]) => (
                  <tr key={path} className="border-b border-line-soft last:border-0">
                    <td className="px-4 py-2.5 font-mono text-[11px] text-ink-3 w-[52px]">{method}</td>
                    <td className="px-2 py-2.5 font-mono text-[11.5px] whitespace-nowrap">{path}</td>
                    <td className="px-4 py-2.5 text-ink-2">{what}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card title="Command line">
            <p className="mb-3">
              The repo ships a thin CLI over the same API. Every command prints the envelope; a failed
              call exits 1.
            </p>
            <pre className={CODE}>{`export ALTORANK_API_KEY=altorank_live_…
npm run cli -- auth whoami
npm run cli -- keywords list --workspace <id>
npm run cli -- articles generate --workspace <id> --keyword "…"`}</pre>
            <p className="mt-3 text-ink-3">
              Agents should read <span className="font-mono">apps/web/scripts/SKILL.md</span> first: it is the
              preflight, the happy path, and the rules.
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}
