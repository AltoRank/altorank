// ---------------------------------------------------------------------------
// The rows the Funnel page and a user's own page are built from
// ---------------------------------------------------------------------------
//
// Server-only: reads across every tenant through the service client, so every
// caller has passed `getOperator()` first. The reshaping is ./funnel.ts.

import type { SupabaseClient, User } from "@supabase/supabase-js";
import { readAllPages, type PageResult } from "@/lib/supabase/read-all";
import { STEP_EVENT_SOURCE } from "@/lib/onboarding/step-names";
import { isAdminEmail } from "@/lib/auth/admin";
import { signupEventsByUser, userOrigin, type SignupEventRow } from "./user-origin";
import {
  buildJourney,
  firstStepsByUser,
  isInternalEmail,
  type FunnelAccount,
  type FunnelRun,
  type FunnelStepEvent,
  type Journey,
} from "./funnel";

export async function listAllUsers(admin: SupabaseClient): Promise<User[]> {
  const users: User[] = [];
  const perPage = 1000;
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`Could not list users: ${error.message}`);
    users.push(...data.users);
    if (data.users.length < perPage) break;
  }
  return users;
}

type MemberRow = { user_id: string; account_id: string; role: string; created_at: string };
type WorkspaceRow = { id: string; account_id: string; domain: string | null; created_at: string };
type ArticleRow = { workspace_id: string; created_at: string };

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * One journey per account owner, newest first. Invited teammates are left
 * out (they did not sign up), and so are our own addresses unless asked for.
 */
export async function readJourneys(admin: SupabaseClient, { includeInternal = false }: { includeInternal?: boolean } = {}): Promise<Journey[]> {
  const all = <T,>(table: string, columns: string) =>
    readAllPages<T>(table, (from, to, count) =>
      admin.from(table).select(`id, ${columns}`, { count }).order("id").range(from, to) as unknown as PromiseLike<PageResult<T>>,
    );
  const events = <T,>(source: string) =>
    readAllPages<T>("system_events", (from, to, count) =>
      admin.from("system_events").select("id, context, created_at", { count }).eq("source", source).order("id").range(from, to) as unknown as PromiseLike<PageResult<T>>,
    ).catch(() => [] as T[]);

  const [users, members, accounts, workspaces, articles, runs, signupEvents, stepEvents] = await Promise.all([
    listAllUsers(admin),
    all<MemberRow>("account_members", "user_id, account_id, role, created_at"),
    all<FunnelAccount>("accounts", "plan_status, attribution_source"),
    all<WorkspaceRow>("workspaces", "account_id, domain, created_at"),
    all<ArticleRow>("articles", "workspace_id, created_at"),
    all<FunnelRun>("onboarding_runs", "account_id, status, started_at, finished_at, article_id, keywords_found, phases, error"),
    events<SignupEventRow>("signup"),
    events<FunnelStepEvent>(STEP_EVENT_SOURCE),
  ]);

  const signupOf = signupEventsByUser(signupEvents);
  const stepsOf = firstStepsByUser(stepEvents);
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const memberOf = new Map<string, MemberRow>();
  for (const m of [...members].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    if (!memberOf.has(m.user_id)) memberOf.set(m.user_id, m);
  }
  const sitesOf = new Map<string, WorkspaceRow[]>();
  for (const w of [...workspaces].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    sitesOf.set(w.account_id, [...(sitesOf.get(w.account_id) ?? []), w]);
  }
  const accountOfWorkspace = new Map(workspaces.map((w) => [w.id, w.account_id]));
  const firstArticleOf = new Map<string, string>();
  for (const a of articles) {
    const accountId = accountOfWorkspace.get(a.workspace_id);
    if (!accountId) continue;
    const seen = firstArticleOf.get(accountId);
    if (!seen || a.created_at < seen) firstArticleOf.set(accountId, a.created_at);
  }
  const runsOf = new Map<string, FunnelRun[]>();
  for (const r of runs) runsOf.set(r.account_id, [...(runsOf.get(r.account_id) ?? []), r]);

  return users
    .filter((u) => includeInternal || !(isAdminEmail(u.email) || isInternalEmail(u.email)))
    .filter((u) => {
      const role = memberOf.get(u.id)?.role;
      return !role || role === "owner";
    })
    .map((u) => {
      const member = memberOf.get(u.id);
      const accountId = member?.account_id;
      const event = signupOf.get(u.id);
      const ctx = (event ?? {}) as { lp?: unknown; src?: unknown };
      return buildJourney({
        user: { id: u.id, email: u.email ?? null, createdAt: u.created_at },
        origin: userOrigin(event),
        page: str(ctx.lp) ?? str(ctx.src),
        account: accountId ? accountById.get(accountId) : undefined,
        site: accountId ? (sitesOf.get(accountId)?.[0]?.domain ?? null) : null,
        steps: stepsOf.get(u.id),
        runs: accountId ? (runsOf.get(accountId) ?? []) : [],
        firstArticleAt: accountId ? (firstArticleOf.get(accountId) ?? null) : null,
      });
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
