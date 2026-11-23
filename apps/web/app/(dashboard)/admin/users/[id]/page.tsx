import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHead, Card, StatStrip, Chip } from "@/components/ui";
import { createServiceClient } from "@/lib/supabase/server";
import { getOperator, isAdminEmail } from "@/lib/auth/admin";
import { attributionLabel, isAttributionSource } from "@/lib/attribution";
import { PLAN_LABELS, type PlanTier } from "@/lib/stripe";
import { STEP_EVENT_SOURCE } from "@/lib/onboarding/step-names";
import { signupEventsByUser, userOrigin, type SignupEventRow } from "@/lib/admin/user-origin";
import {
  FUNNEL_STAGES,
  buildJourney,
  firstStepsByUser,
  runOutcome,
  spanLabel,
  timeline,
  type FunnelRun,
  type TimelineEntry,
} from "@/lib/admin/funnel";
import { AdminTabs } from "../../admin-tabs";
import { Table } from "../../table";

export const metadata: Metadata = { title: "User" };

/**
 * Everything recorded about one user, on one page: where they came from, how
 * far they got, and each thing that happened in the order it happened.
 *
 * It is the read an operator made by hand after every signup (the export
 * script, then six JSON files). Gated and read like every Operations pane.
 * Nothing is inferred: the timeline is rows, each said in the words the call
 * site wrote.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Enough for any one account's history; a busier one says it was cut. */
const EVENT_LIMIT = 500;

type EventRow = { id: string; created_at: string; level: "info" | "warn" | "error"; source: string; message: string; context: Record<string, unknown> | null };
type WorkspaceRow = { id: string; domain: string | null; status: string | null; detected_platform: string | null; language: string | null; created_at: string; first_analysed_at: string | null };
type ArticleRow = { id: string; workspace_id: string; title: string | null; keyword: string | null; status: string; word_count: number | null; created_at: string; published_at: string | null; found_on_site_at: string | null };
type AccountRow = { id: string; name: string; plan: PlanTier | null; plan_status: string | null; trial_ends_at: string | null; attribution_source: string | null; attribution_note: string | null; created_at: string };

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
const clock = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const usd = (n: number) => `$${n.toFixed(2)}`;

/** The context keys worth a second line; ids and the step name are already said. */
function contextLine(context: Record<string, unknown> | null): string | null {
  if (!context) return null;
  const skip = new Set(["userId", "step", "runId", "stage", "ms", "count", "secondsSinceSignup"]);
  const parts = Object.entries(context)
    .filter(([k, v]) => !skip.has(k) && v !== null && v !== "" && v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  return parts.length ? parts.join("  ").slice(0, 300) : null;
}

const LEVEL_CLASS: Record<TimelineEntry["level"], string> = { info: "text-ink-3", warn: "text-warn-ink", error: "text-err-ink" };

export default async function AdminUserPage({ params }: { params: Promise<{ id: string }> }) {
  const operator = await getOperator();
  if (!operator) notFound();

  const { id } = await params;
  if (!UUID.test(id)) notFound();

  const admin = createServiceClient();
  const { data: found } = await admin.auth.admin.getUserById(id);
  const user = found?.user;
  if (!user) notFound();

  const { data: memberships } = await admin
    .from("account_members")
    .select("account_id, role, created_at")
    .eq("user_id", id)
    .order("created_at");
  const member = memberships?.[0];
  const accountId: string | null = member?.account_id ?? null;

  const none = Promise.resolve({ data: [] as never[] });
  const [{ data: accountRows }, { data: workspaceRows }, { data: runRows }, { data: emailRows }, { data: gateRows }, { data: eventRows }] = await Promise.all([
    accountId
      ? admin.from("accounts").select("id, name, plan, plan_status, trial_ends_at, attribution_source, attribution_note, created_at").eq("id", accountId)
      : none,
    accountId
      ? admin.from("workspaces").select("id, domain, status, detected_platform, language, created_at, first_analysed_at").eq("account_id", accountId).order("created_at")
      : none,
    accountId
      ? admin.from("onboarding_runs").select("id, account_id, status, started_at, finished_at, article_id, keywords_found, phases, error").eq("account_id", accountId).order("started_at")
      : none,
    accountId ? admin.from("sent_emails").select("email_type, sent_at").eq("account_id", accountId).order("sent_at") : none,
    accountId ? admin.from("gate_visits").select("day, seen_at").eq("account_id", accountId).order("seen_at") : none,
    admin
      .from("system_events")
      .select("id, created_at, level, source, message, context")
      .or(accountId ? `account_id.eq.${accountId},context->>userId.eq.${id}` : `context->>userId.eq.${id}`)
      .order("created_at", { ascending: false })
      .limit(EVENT_LIMIT),
  ]);

  const account = (accountRows?.[0] ?? undefined) as AccountRow | undefined;
  const workspaces = (workspaceRows ?? []) as WorkspaceRow[];
  const runs = (runRows ?? []) as Array<FunnelRun & { id: string }>;
  const events = ((eventRows ?? []) as EventRow[]).slice().reverse();
  const workspaceIds = workspaces.map((w) => w.id);

  const [{ data: articleRows }, { data: spendRows }] = await Promise.all([
    workspaceIds.length
      ? admin.from("articles").select("id, workspace_id, title, keyword, status, word_count, created_at, published_at, found_on_site_at").in("workspace_id", workspaceIds).order("created_at")
      : none,
    workspaceIds.length ? admin.from("provider_spend").select("provider, cost_usd").in("workspace_id", workspaceIds).limit(10000) : none,
  ]);
  const articles = (articleRows ?? []) as ArticleRow[];
  const spend = new Map<string, { calls: number; usd: number }>();
  for (const s of (spendRows ?? []) as Array<{ provider: string; cost_usd: number | string | null }>) {
    const row = spend.get(s.provider) ?? { calls: 0, usd: 0 };
    row.calls += 1;
    row.usd += Number(s.cost_usd ?? 0);
    spend.set(s.provider, row);
  }
  const spendTotal = [...spend.values()].reduce((n, s) => n + s.usd, 0);

  const signupEvent = signupEventsByUser(events.filter((e) => e.source === "signup") as SignupEventRow[]).get(id);
  const invited = Boolean(member && member.role !== "owner");
  const origin = userOrigin(signupEvent, { invited });
  const ctx = (signupEvent ?? {}) as { lp?: unknown; src?: unknown };
  const journey = buildJourney({
    user: { id, email: user.email ?? null, createdAt: user.created_at },
    origin,
    page: typeof ctx.lp === "string" ? ctx.lp : typeof ctx.src === "string" ? ctx.src : null,
    account,
    site: workspaces[0]?.domain ?? null,
    steps: firstStepsByUser(events.filter((e) => e.source === STEP_EVENT_SOURCE)).get(id),
    runs,
    firstArticleAt: articles[0]?.created_at ?? null,
  });
  const domainOf = new Map(workspaces.map((w) => [w.id, w.domain ?? "site"]));

  const recorded: Array<TimelineEntry | null> = [
    { at: user.created_at, kind: "account", level: "info", what: "Signed up", detail: origin.kind === "unknown" ? null : [origin.label, origin.detail].filter(Boolean).join(" · ") },
    user.email_confirmed_at ? { at: user.email_confirmed_at, kind: "account", level: "info", what: "Confirmed their address", detail: null } : null,
    ...workspaces.map((w): TimelineEntry => ({ at: w.created_at, kind: "account", level: "info", what: `Added ${w.domain ?? "a site"}`, detail: [w.detected_platform, w.language].filter(Boolean).join(" · ") || null })),
    ...runs.flatMap((r): TimelineEntry[] => {
      const outcome = runOutcome(r);
      return [
        { at: r.started_at, kind: "run", level: "info", what: "First look started", detail: null },
        ...(r.finished_at
          ? [{
              at: r.finished_at,
              kind: "run" as const,
              level: outcome ? ("warn" as const) : ("info" as const),
              what: outcome ? "First look ended with no article" : "First look wrote an article",
              detail: [outcome, `${r.keywords_found ?? 0} keywords`, spanLabel((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 60000)].filter(Boolean).join(" · "),
            }]
          : []),
      ];
    }),
    ...articles.map((a): TimelineEntry => ({ at: a.created_at, kind: "article", level: "info", what: `Article drafted: ${a.title ?? a.keyword ?? "untitled"}`, detail: [domainOf.get(a.workspace_id), a.status, a.word_count ? `${a.word_count} words` : null].filter(Boolean).join(" · ") })),
    ...articles.filter((a) => a.published_at).map((a): TimelineEntry => ({ at: a.published_at as string, kind: "article", level: "info", what: `Article published: ${a.title ?? a.keyword ?? "untitled"}`, detail: null })),
    ...articles.filter((a) => a.found_on_site_at).map((a): TimelineEntry => ({ at: a.found_on_site_at as string, kind: "article", level: "info", what: `Article found on their site: ${a.title ?? a.keyword ?? "untitled"}`, detail: null })),
    ...((emailRows ?? []) as Array<{ email_type: string; sent_at: string }>).map((e): TimelineEntry => ({ at: e.sent_at, kind: "email", level: "info", what: `Email sent: ${e.email_type}`, detail: null })),
    ...((gateRows ?? []) as Array<{ day: string; seen_at: string }>).map((g): TimelineEntry => ({ at: g.seen_at, kind: "gate", level: "info", what: "Saw the pre-trial gate", detail: `day ${g.day}` })),
    // The signup row is the first entry already; every other event as written.
    ...events
      .filter((e) => e.source !== "signup" || (e.context?.stage !== "created" && e.context?.stage !== "fallback"))
      .map((e): TimelineEntry => ({ at: e.created_at, kind: e.source === STEP_EVENT_SOURCE ? "step" : "event", level: e.level, what: e.message, detail: [e.source === STEP_EVENT_SOURCE ? null : e.source, contextLine(e.context)].filter(Boolean).join("  ") || null })),
    user.last_sign_in_at ? { at: user.last_sign_in_at, kind: "account", level: "info", what: "Last sign-in", detail: "may be an operator's “View as”" } : null,
  ];
  const entries = timeline(recorded);

  const stageLabel = Object.fromEntries(FUNNEL_STAGES.map((s) => [s.key, s.label]));
  const onPlan = account && (account.plan_status === "active" || account.plan_status === "trialing") && account.plan;
  const declared = account?.attribution_source
    ? `${isAttributionSource(account.attribution_source) ? attributionLabel(account.attribution_source) : account.attribution_source}${account.attribution_note ? `: ${account.attribution_note}` : ""}`
    : "Not answered";

  return (
    <>
      <PageHead
        title="Operations"
        subtitle={
          <span className="flex items-center gap-2">
            <Link href="/admin/users" className="text-ink-3 hover:text-ink">
              Users
            </Link>
            <span className="text-ink-3">/</span>
            <span>{user.email ?? id}</span>
            {isAdminEmail(user.email) && <Chip label="operator" soft />}
            {!user.email_confirmed_at && <Chip label="unconfirmed" soft />}
          </span>
        }
      />

      <AdminTabs />

      <StatStrip
        stats={[
          { label: "Got as far as", value: stageLabel[journey.furthest], delta: `signed up ${when(user.created_at)}` },
          { label: "Source", value: origin.label, delta: origin.detail ?? "—" },
          { label: "Plan", value: onPlan ? PLAN_LABELS[account.plan as PlanTier] : "No plan", delta: account?.plan_status ?? "no account" },
          { label: "Articles", value: articles.length, delta: `${runs.length} first ${runs.length === 1 ? "look" : "looks"}` },
          { label: "Spent on them", value: usd(spendTotal), delta: [...spend.entries()].map(([p, s]) => `${p} ${usd(s.usd)}`).join(" · ") || "no provider calls" },
        ]}
      />

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll flex flex-col gap-5">
        <Card className="shrink-0" title="Journey" meta="When each stage was first reached. A dash is a stage with no record, not a guess." flush>
          <Table
            head={["Stage", "Reached", "After signup"]}
            rows={FUNNEL_STAGES.map((s) => {
              const at = journey.at[s.key];
              const fromPlan = journey.undated.includes(s.key);
              return [
                <span key="s" className={`font-sans text-[13px] ${at ? "font-medium text-ink" : "text-ink-3"}`}>
                  {s.label}
                </span>,
                !at ? "—" : fromPlan ? "yes, from the plan on the account" : when(at),
                !at || fromPlan || s.key === "signed_up" ? "—" : spanLabel((new Date(at).getTime() - new Date(user.created_at).getTime()) / 60000),
              ];
            })}
          />
        </Card>

        <Card className="shrink-0" title="Account" flush>
          <Table
            head={["", ""]}
            rows={[
              ["Account", account ? `${account.name}${member ? ` · ${member.role}` : ""}` : "no account"],
              ["Sites", workspaces.map((w) => `${w.domain ?? "—"} (${w.status ?? "—"})`).join(", ") || "—"],
              ["How they heard", declared],
              ["Trial ends", when(account?.trial_ends_at)],
              ["If no draft, why", journey.runOutcome ?? "—"],
              ["Last sign-in", when(user.last_sign_in_at)],
              ["Sign-in method", String(user.app_metadata?.provider ?? "—")],
            ].map(([k, v]) => [
              <span key="k" className="font-sans text-[13px] text-ink-3">
                {k}
              </span>,
              <span key="v" className="font-sans text-[13px] text-ink">
                {v}
              </span>,
            ])}
          />
        </Card>

        <Card
          className="shrink-0"
          title="Timeline"
          meta={`Oldest first: account, onboarding steps, first looks, articles, emails and every event logged against them.${(eventRows ?? []).length >= EVENT_LIMIT ? ` Events are cut to the newest ${EVENT_LIMIT}.` : ""}`}
          flush
        >
          <Table
            head={["When", "Kind", "What happened"]}
            empty="Nothing recorded."
            rows={entries.map((e) => [
              <span key="t" className="font-mono text-xs whitespace-nowrap">
                {clock(e.at)}
              </span>,
              <span key="k" className={LEVEL_CLASS[e.level]}>
                {e.level === "info" ? e.kind : `${e.kind} · ${e.level}`}
              </span>,
              <span key="w" className="flex flex-col gap-0.5 font-sans text-[13px]">
                <span className="text-ink">{e.what}</span>
                {e.detail && <span className="text-[12px] text-ink-3 break-words">{e.detail}</span>}
              </span>,
            ])}
          />
        </Card>
      </div>
    </>
  );
}
