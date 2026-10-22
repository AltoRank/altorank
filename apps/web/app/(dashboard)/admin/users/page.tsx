import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { PageHead, Card, StatStrip, Chip } from "@/components/ui";
import { createServiceClient } from "@/lib/supabase/server";
import { getOperator, isAdminEmail } from "@/lib/auth/admin";
import { PLAN_LABELS, type PlanTier } from "@/lib/stripe";
import type { AdminImpersonation } from "@/lib/types";
import { plural } from "@/lib/utils";
import { AdminTabs } from "../admin-tabs";
import { Table } from "../table";
import { ImpersonateButton } from "./impersonate-button";
import { tallyArticles } from "@/lib/found-on-site/state";
import { readAllPages, type PageResult } from "@/lib/supabase/read-all";
import { customerLastSeen, type CustomerLastSeen, type ViewRecord } from "@/lib/auth/last-seen";
import { originSearchText, signupEventsByUser, userOrigin, type SignupEventRow } from "@/lib/admin/user-origin";

export const metadata: Metadata = { title: "Users" };

/**
 * Every account, and a way into each one.
 *
 * Reads across all tenants, so like the costs pane it is gated on the operator
 * email and uses the service client: auth.users is not reachable any other
 * way, and RLS would hide every row that is not ours.
 *
 * Nothing here is estimated. A user who has never signed in shows a dash under
 * "last seen", not a date; an account with no subscription shows "No plan",
 * not the `starter` default the row was created with.
 */

async function listAllUsers(admin: SupabaseClient): Promise<User[]> {
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

type AccountRow = { id: string; name: string; plan: PlanTier | null; plan_status: string | null };
type MemberRow = { user_id: string; account_id: string; role: string };
type WorkspaceRow = { id: string; account_id: string; domain: string | null };

const day = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";
const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

function displayName(u: User): string | null {
  const meta = u.user_metadata ?? {};
  const name = (meta.name ?? meta.full_name) as unknown;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

/** Users whose own last sign-in falls inside the trailing window. Outside the
 *  component so the clock read is not part of render. */
function seenWithin(seen: CustomerLastSeen[], days: number): number {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  return seen.filter((s) => s.at && new Date(s.at).getTime() >= since).length;
}

/**
 * Every "View as", by the customer it opened: the sign-in it made is not the
 * customer's (lib/auth/last-seen.ts). The kept prior sign-in is read when
 * migration 116 is there, and the rows are read without it when it is not.
 */
async function viewsByTarget(admin: SupabaseClient): Promise<Map<string, ViewRecord[]>> {
  type Row = { target_user_id: string; started_at: string; target_last_sign_in_at?: string | null };
  let rows: Row[] = [];
  try {
    rows = await readAllPages<Row>("admin_impersonations", (from, to, count) =>
      admin.from("admin_impersonations").select("id, target_user_id, started_at, target_last_sign_in_at", { count }).order("id").range(from, to),
    );
  } catch {
    rows = await readAllPages<Row>("admin_impersonations", (from, to, count) =>
      admin.from("admin_impersonations").select("id, target_user_id, started_at", { count }).order("id").range(from, to),
    ).catch(() => []);
  }
  const out = new Map<string, ViewRecord[]>();
  for (const r of rows) {
    const list = out.get(r.target_user_id) ?? [];
    list.push({ startedAt: r.started_at, priorSignInAt: "target_last_sign_in_at" in r ? (r.target_last_sign_in_at ?? null) : undefined });
    out.set(r.target_user_id, list);
  }
  return out;
}

function planLabel(account: AccountRow | undefined): string {
  if (!account) return "—";
  const active = account.plan_status === "active" || account.plan_status === "trialing";
  if (!active || !account.plan) return "No plan";
  return `${PLAN_LABELS[account.plan]} · ${account.plan_status}`;
}

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const operator = await getOperator();
  if (!operator) notFound();

  const { q = "" } = await searchParams;
  const needle = q.trim().toLowerCase();

  const admin = createServiceClient();
  // Every row, not the first thousand: PostgREST stops at max_rows without a
  // word, and these are counted (lib/supabase/read-all.ts).
  const all = <T,>(table: string, columns: string) =>
    readAllPages<T>(table, (from, to, count) =>
      admin.from(table).select(`id, ${columns}`, { count }).order("id").range(from, to) as unknown as PromiseLike<PageResult<T>>,
    );
  const [users, members, accounts, workspaces, articles, { data: log }, views, signupEvents] =
    await Promise.all([
      listAllUsers(admin),
      all<MemberRow>("account_members", "user_id, account_id, role"),
      all<AccountRow>("accounts", "name, plan, plan_status"),
      all<WorkspaceRow>("workspaces", "account_id, domain"),
      all<{ workspace_id: string; status: string; found_on_site_at: string | null }>("articles", "workspace_id, status, found_on_site_at"),
      admin
        .from("admin_impersonations")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(25),
      viewsByTarget(admin),
      // Where each user came from: the one `signup` event each door writes
      // (lib/admin/user-origin.ts). A failed read leaves the column blank,
      // never the page.
      readAllPages<SignupEventRow>("system_events", (from, to, count) =>
        admin.from("system_events").select("id, context, created_at", { count }).eq("source", "signup").order("id").range(from, to),
      ).catch(() => [] as SignupEventRow[]),
    ]);
  const signupOf = signupEventsByUser(signupEvents);
  // Last seen is the customer's own sign-in, not the one "View as" made.
  const seenOf = new Map(users.map((u) => [u.id, customerLastSeen(u.last_sign_in_at, views.get(u.id) ?? [])]));

  const accountById = new Map((accounts ?? []).map((a) => [a.id, a as AccountRow]));
  const membersByUser = new Map<string, MemberRow[]>();
  for (const m of (members ?? []) as MemberRow[]) {
    membersByUser.set(m.user_id, [...(membersByUser.get(m.user_id) ?? []), m]);
  }
  const workspacesByAccount = new Map<string, WorkspaceRow[]>();
  for (const w of (workspaces ?? []) as WorkspaceRow[]) {
    workspacesByAccount.set(w.account_id, [...(workspacesByAccount.get(w.account_id) ?? []), w]);
  }
  // Live counts include articles the nightly check found on the customer's
  // own site (lib/found-on-site): the first real signup published a draft by
  // hand and read as "never used it" here.
  const articlesByWorkspace = tallyArticles(
    (articles ?? []) as Array<{ workspace_id: string; status: string; found_on_site_at: string | null }>,
  );

  const rows = users
    .map((u) => {
      const memberships = membersByUser.get(u.id) ?? [];
      const primary = memberships[0];
      const account = primary ? accountById.get(primary.account_id) : undefined;
      const ws = account ? workspacesByAccount.get(account.id) ?? [] : [];
      const domains = ws.map((w) => w.domain).filter((d): d is string => Boolean(d));
      const tallies = ws.map((w) => articlesByWorkspace.get(w.id));
      const articleCount = tallies.reduce((n, t) => n + (t?.total ?? 0), 0);
      const liveCount = tallies.reduce((n, t) => n + (t?.live ?? 0), 0);
      const foundCount = tallies.reduce((n, t) => n + (t?.foundOnSite ?? 0), 0);
      return {
        user: u,
        name: displayName(u),
        account,
        role: primary?.role ?? null,
        extraAccounts: Math.max(0, memberships.length - 1),
        domains,
        articleCount,
        liveCount,
        foundCount,
        origin: userOrigin(signupOf.get(u.id), { invited: Boolean(primary && primary.role !== "owner") }),
        operator: isAdminEmail(u.email),
      };
    })
    .filter((r) => {
      if (!needle) return true;
      const hay = [r.user.email, r.name, r.account?.name, ...r.domains, originSearchText(r.origin)]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(needle);
    })
    .sort((a, b) => (b.user.created_at ?? "").localeCompare(a.user.created_at ?? ""));

  const confirmed = users.filter((u) => u.email_confirmed_at).length;
  const seenThisWeek = seenWithin([...seenOf.values()], 7);
  const paying = (accounts ?? []).filter((a) => a.plan_status === "active" || a.plan_status === "trialing").length;

  return (
    <>
      <PageHead
        title="Operations"
        subtitle={
          <span>
            {plural(users.length, "account")}
            {needle ? ` · ${plural(rows.length, "match", "matches")}` : ""}
          </span>
        }
        actions={
          <form method="get" className="flex items-center gap-2">
            <input
              type="search"
              name="q"
              defaultValue={q}
              placeholder="Email, name, account, domain or source"
              aria-label="Search users"
              className="w-[260px] rounded-[7px] border border-line bg-panel-2 px-2.5 py-1.5 text-[13px] focus:border-line focus:bg-bg focus:outline-0"
            />
            {needle && (
              <Link href="/admin/users" className="text-[12.5px] text-ink-3 hover:text-ink">
                Clear
              </Link>
            )}
          </form>
        }
      />

      <AdminTabs />

      <StatStrip
        stats={[
          { label: "Users", value: String(users.length), delta: `${confirmed} confirmed` },
          { label: "Seen this week", value: String(seenThisWeek), delta: "signed in within 7 days" },
          { label: "Accounts", value: String((accounts ?? []).length), delta: `${paying} on a plan` },
          {
            label: "Workspaces",
            value: String((workspaces ?? []).length),
            delta: `${(articles ?? []).length} articles in total`,
          },
        ]}
      />

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll flex flex-col gap-5">
        <Card
          className="shrink-0"
          title="Users"
          meta="“View as” signs in as them in this tab, with a bar to come back. Paid setup steps are refused while you view, and Last seen stays theirs. Every use is logged below."
          flush
        >
          <Table
            head={["User", "Account", "Source", "Plan", "Workspaces", "Articles", "Signed up", "Last seen", ""]}
            empty={needle ? "No user matches that." : "No users yet."}
            rows={rows.map((r) => [
              <span key="who" className="flex flex-col gap-0.5">
                <span className="flex items-center gap-2">
                  <span className="font-medium text-ink">{r.user.email ?? "—"}</span>
                  {r.operator && <Chip label="operator" soft />}
                  {!r.user.email_confirmed_at && <Chip label="unconfirmed" soft />}
                </span>
                {r.name && <span className="text-[12px] text-ink-3">{r.name}</span>}
              </span>,
              <span key="account" className="font-sans text-[13px]">
                {r.account ? (
                  <>
                    {r.account.name}
                    {r.role && <span className="text-ink-3"> · {r.role}</span>}
                    {r.extraAccounts > 0 && <span className="text-ink-3"> +{r.extraAccounts}</span>}
                  </>
                ) : (
                  <span className="text-ink-3">no account</span>
                )}
              </span>,
              <span key="source" className="flex flex-col gap-0.5 font-sans text-[13px]" title={r.origin.detail ?? undefined}>
                <span className={r.origin.kind === "unknown" ? "text-ink-3" : "text-ink"}>{r.origin.label}</span>
                {r.origin.detail && r.origin.kind !== "unknown" && <span className="text-[12px] text-ink-3">{r.origin.detail}</span>}
              </span>,
              planLabel(r.account),
              <span key="ws" className="font-sans text-[13px]" title={r.domains.join(", ")}>
                {r.domains.length === 0 ? (
                  <span className="text-ink-3">—</span>
                ) : (
                  <>
                    {r.domains.slice(0, 2).join(", ")}
                    {r.domains.length > 2 && <span className="text-ink-3"> +{r.domains.length - 2}</span>}
                  </>
                )}
              </span>,
              <span key="articles" className="font-sans text-[13px]">
                {r.articleCount}
                {r.liveCount > 0 && (
                  <span className="text-ink-3">
                    {" "}· {r.liveCount} live{r.foundCount > 0 ? `, ${r.foundCount} found on their site` : ""}
                  </span>
                )}
              </span>,
              day(r.user.created_at),
              seenOf.get(r.user.id)?.unknown ? (
                <span key="seen" className="text-ink-3" title="Their last sign-in was a View as, and the one before it is not on record.">
                  — (View as)
                </span>
              ) : (
                when(seenOf.get(r.user.id)?.at)
              ),
              <span key="act" className="flex justify-end">
                <ImpersonateButton
                  userId={r.user.id}
                  email={r.user.email ?? r.user.id}
                  disabledReason={
                    r.user.id === operator.id
                      ? "This is you."
                      : !r.user.email_confirmed_at
                        ? "Unconfirmed address: opening it would confirm it on their behalf."
                        : undefined
                  }
                />
              </span>,
            ])}
          />
        </Card>

        <Card className="shrink-0" title="Recent “view as” sessions" meta="Newest first. Open rows have no end time yet." flush>
          <Table
            head={["Operator", "Viewed", "Started", "Ended", "Outcome"]}
            empty="Nobody has viewed as another account yet."
            rows={((log ?? []) as AdminImpersonation[]).map((e) => [
              e.operator_email,
              e.target_email,
              when(e.started_at),
              when(e.ended_at),
              e.end_reason ?? (e.ended_at ? "—" : "open"),
            ])}
          />
        </Card>
      </div>
    </>
  );
}
