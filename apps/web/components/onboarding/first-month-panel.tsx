import Link from "next/link";
import { after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { Quota } from "@/lib/billing/quota";
import { wakeFirstMonth } from "@/lib/onboarding/first-month";
import { FirstMonthProgress } from "./first-month-progress";

export async function FirstMonthPanel({ workspaceId, quota, role, now }: { workspaceId: string; quota: Quota; role: string; now: Date }) {
  const db = await createClient();
  const [onboarding, preparation] = await Promise.all([
    db.from("onboarding_runs").select("article_id, started_at").eq("workspace_id", workspaceId).not("article_id", "is", null).order("started_at", { ascending: true }).limit(1).maybeSingle(),
    db.from("first_month_runs").select("starts_on, status, message").eq("workspace_id", workspaceId).maybeSingle(),
  ]);
  if (onboarding.error || preparation.error) return <p className="mb-6 text-sm text-ink-2">Your first-month overview could not load. <Link href="/content" className="text-accent underline">Open your saved articles</Link></p>;
  if (!onboarding.data) return null;
  const start = preparation.data?.starts_on ?? onboarding.data.started_at.slice(0, 10);
  const end = new Date(new Date(`${start}T00:00:00Z`).getTime() + 30 * 86400000).toISOString().slice(0, 10);
  if (now.getTime() >= new Date(`${end}T00:00:00Z`).getTime()) return null;
  const [first, entries, jobs] = await Promise.all([
    db.from("articles").select("id, title, word_count, status").eq("workspace_id", workspaceId).eq("id", onboarding.data.article_id).maybeSingle(),
    db.from("calendar_entries").select("id, keyword, scheduled_date, article_id").eq("workspace_id", workspaceId).gte("scheduled_date", start).lt("scheduled_date", end).order("scheduled_date"),
    db.from("first_month_jobs").select("entry_id, status").eq("workspace_id", workspaceId),
  ]);
  if (first.error || entries.error || jobs.error) return <p className="mb-6 text-sm">Your first-month overview is temporarily unavailable. <Link href="/content" className="text-accent underline">Open your saved articles</Link></p>;
  const pending = ["queued", "planning", "writing"].includes(preparation.data?.status ?? "");
  // Refreshes also rescue an interrupted dispatch. The database lease makes
  // this harmless while a worker is already alive; cron does the same on exit.
  if (pending) after(() => wakeFirstMonth(workspaceId));
  const remaining = (entries.data ?? []).filter((entry) => entry.article_id !== first.data?.id);
  const articleIds = remaining.map((entry) => entry.article_id).filter(Boolean);
  const articles = articleIds.length ? await db.from("articles").select("id, status, title").eq("workspace_id", workspaceId).in("id", articleIds) : { data: [], error: null };
  if (articles.error) return <p className="mb-6 text-sm">Article progress could not load. <Link href="/content" className="text-accent underline">Open your saved articles</Link></p>;
  const byId = new Map((articles.data ?? []).map((article) => [article.id, article]));
  const jobByEntry = new Map((jobs.data ?? []).map((job) => [job.entry_id, job.status]));
  const ready = remaining.filter((entry) => ["review", "approved", "scheduled", "live"].includes(byId.get(entry.article_id)?.status ?? "")).length;
  return <section aria-label="Your first month" className="mb-6 rounded-xl border border-accent/30 bg-panel p-5 sm:p-6">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="text-xl font-semibold">Your first month starts here</h2>
      {quota.trial && <Link className="text-sm text-accent underline" href="/settings/billing">Trial ends {new Date(quota.trial.endsAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}</Link>}
    </div>
    <p className="mt-2 text-sm text-ink-2">Review your first article, then work through the drafts for your next 30 days. Dates are your plan; each article still needs your approval.</p>
    {first.data && <div className="mt-5 rounded-lg border border-line p-4">
      <p className="text-xs uppercase tracking-wide text-ink-3">Your onboarding draft · {first.data.word_count?.toLocaleString()} words · {first.data.status === "review" ? "Ready for your review" : first.data.status}</p>
      <h3 className="mt-2 text-lg font-medium">{first.data.title}</h3>
      <Link className="mt-3 inline-block rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white" href={`/content/${first.data.id}`}>{role === "viewer" ? "Read your first draft" : "Review and edit your first draft"}</Link>
    </div>}
    {quota.limit !== null && <p className="mt-4 text-sm text-ink-2"><strong>{quota.used} of {quota.limit} articles used</strong> this calendar month across your account · {quota.remaining} remaining. The saved preview counts once; starting a trial does not generate it again.</p>}
    <div className="mt-5 flex flex-wrap items-baseline justify-between gap-2"><h3 className="font-semibold">Next in your plan</h3><Link href="/content" className="text-sm text-accent underline">Adjust dates and topics</Link></div>
    <p className="mt-1 text-sm text-ink-2">{ready} more {ready === 1 ? "draft" : "drafts"} ready · {remaining.length} more {remaining.length === 1 ? "topic" : "topics"} planned. We fill supported topics within your cadence and available allowance.</p>
    {!remaining.length && <p className="mt-3 text-sm text-ink-2">{pending ? "Checking which additional topics have enough evidence to write." : "No additional topics have enough evidence in this plan yet. Refine your business focus or research more keywords to expand it."}</p>}
    {remaining.length > 0 && <ul className="mt-3 divide-y divide-line">{remaining.map((entry) => {
      const article = byId.get(entry.article_id);
      const readable = article && ["review", "approved", "scheduled", "live"].includes(article.status);
      const status = readable ? article.status === "review" ? "Ready for review" : article.status : jobByEntry.get(entry.id) === "writing" ? "Writing" : jobByEntry.get(entry.id) === "failed" ? "Needs attention" : "Planned";
      return <li key={entry.id} className="flex flex-wrap items-baseline justify-between gap-2 py-3 text-sm"><span className="min-w-0">{readable ? <Link className="text-accent underline" href={`/content/${article.id}`}>{article.title}</Link> : entry.keyword}<span className="ml-2 text-xs text-ink-3">{entry.scheduled_date}</span></span><span className="text-xs text-ink-2">{status}</span></li>;
    })}</ul>}
    {preparation.data?.message && <p className="mt-3 text-sm text-ink-2">{preparation.data.message}</p>}
    <FirstMonthProgress active={pending} canRetry={role !== "viewer" && ["attention", "blocked"].includes(preparation.data?.status ?? "")} />
    <p className="mt-5 text-sm text-ink-2">Next: review the evidence and edit your draft, approve it when ready, then <Link className="text-accent underline" href="/connect">connect your publishing platform</Link>. Connect Search Console to measure results after publishing.</p>
  </section>;
}
