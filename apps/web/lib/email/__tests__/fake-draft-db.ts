// A small in-memory Postgres for the draft digest's tests.
//
// `fake-email-db.ts` covers the two tables `sendOnce` touches. This one has to
// go further, because `announceDraftBatch` reads a workspace, its drafts, their
// keywords and its CMS connections, then writes a hold stamp and a row per
// article it announced. Faking those with `() => q` stubs would let a query
// with the wrong filter pass, and the filters are the behaviour: "only drafts
// nobody has been told about" is one `.in()` away from "every draft ever".
//
// So the filters are really applied, against real rows, and the send-once
// primary key really rejects a second claim with 23505.

type Row = Record<string, unknown>;
type Filter = (r: Row) => boolean;

const val = (r: Row, col: string) => r[col];

class Query {
  private filters: Filter[] = [];
  private limitTo: number | null = null;
  constructor(
    private rows: Row[],
    private onWrite?: (patch: Row, matched: Row[]) => void,
  ) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => val(r, c) === v); return this; }
  neq(c: string, v: unknown) { this.filters.push((r) => val(r, c) !== v); return this; }
  gte(c: string, v: string) { this.filters.push((r) => String(val(r, c) ?? "") >= v); return this; }
  lte(c: string, v: string) { this.filters.push((r) => String(val(r, c) ?? "") <= v); return this; }
  is(c: string, v: null) { this.filters.push((r) => (val(r, c) ?? null) === v); return this; }
  in(c: string, vs: readonly unknown[]) { this.filters.push((r) => vs.includes(val(r, c))); return this; }
  not(c: string, _op: string, v: unknown) { this.filters.push((r) => (val(r, c) ?? null) !== v); return this; }
  order(c: string, o?: { ascending?: boolean }) {
    const dir = o?.ascending === false ? -1 : 1;
    this.rows = [...this.rows].sort((a, b) => (String(val(a, c) ?? "") < String(val(b, c) ?? "") ? -dir : dir));
    return this;
  }
  limit(n: number) { this.limitTo = n; return this; }
  private matched(): Row[] {
    const hit = this.rows.filter((r) => this.filters.every((f) => f(r)));
    return this.limitTo == null ? hit : hit.slice(0, this.limitTo);
  }
  /** `update(...)` returns a query; awaiting it applies the patch to the matches. */
  update(patch: Row) {
    const next = new Query(this.rows, (p, matched) => {
      for (const r of matched) Object.assign(r, p);
    });
    (next as unknown as { pendingPatch: Row }).pendingPatch = patch;
    return next;
  }
  async maybeSingle() { return { data: this.matched()[0] ?? null, error: null }; }
  async single() { return { data: this.matched()[0] ?? null, error: null }; }
  then(resolve: (v: { data: Row[]; error: null }) => unknown) {
    const hit = this.matched();
    const patch = (this as unknown as { pendingPatch?: Row }).pendingPatch;
    if (patch && this.onWrite) this.onWrite(patch, hit);
    return Promise.resolve(resolve({ data: hit, error: null }));
  }
}

export type FakeDraftDb = {
  client: never;
  tables: {
    workspaces: Row[];
    articles: Row[];
    keywords: Row[];
    workspace_integrations: Row[];
    agency_members: Row[];
    sent_emails: Row[];
  };
  /** "type|subject|recipient" for every claim currently held. */
  claims: Set<string>;
  /** Addresses that unsubscribed, by category. */
  preferences: Record<string, string[]>;
};

const key = (r: Row) => `${r.email_type}|${r.subject_id}|${r.recipient}`;

export function fakeDraftDb(seed: Partial<FakeDraftDb["tables"]> & { preferences?: Record<string, string[]>; emails?: Record<string, string> } = {}): FakeDraftDb {
  const tables: FakeDraftDb["tables"] = {
    workspaces: seed.workspaces ?? [],
    articles: seed.articles ?? [],
    keywords: seed.keywords ?? [],
    workspace_integrations: seed.workspace_integrations ?? [],
    agency_members: seed.agency_members ?? [],
    sent_emails: seed.sent_emails ?? [],
  };
  const preferences = seed.preferences ?? {};
  const emails = seed.emails ?? {};
  const claims = new Set<string>(tables.sent_emails.map(key));

  const sentEmails = () => ({
    select: () => new Query(tables.sent_emails),
    insert: async (row: Row) => {
      if (claims.has(key(row))) return { error: { code: "23505", message: "duplicate key" } };
      claims.add(key(row));
      tables.sent_emails.push(row);
      return { error: null };
    },
    upsert: async (rows: Row[]) => {
      for (const row of rows) {
        if (claims.has(key(row))) continue;
        claims.add(key(row));
        tables.sent_emails.push(row);
      }
      return { error: null };
    },
    delete: () => {
      const parts: string[] = [];
      const chain = {
        eq(_c: string, v: string) {
          parts.push(v);
          if (parts.length < 3) return chain;
          claims.delete(parts.join("|"));
          const i = tables.sent_emails.findIndex((r) => key(r) === parts.join("|"));
          if (i >= 0) tables.sent_emails.splice(i, 1);
          return Promise.resolve({ error: null });
        },
      };
      return chain;
    },
  });

  const client = {
    from(table: string) {
      if (table === "sent_emails") return sentEmails() as never;
      if (table === "email_preferences") {
        return {
          select: () => ({
            in: async (_c: string, list: string[]) => ({
              data: list.filter((e) => preferences[e]).map((e) => ({ email: e, unsubscribed: preferences[e] })),
              error: null,
            }),
          }),
        } as never;
      }
      const rows = (tables as Record<string, Row[]>)[table];
      if (!rows) throw new Error(`unexpected table ${table}`);
      return new Query(rows) as never;
    },
    auth: {
      admin: {
        getUserById: async (id: string) => ({ data: { user: { email: emails[id] ?? `${id}@x.co` } } }),
      },
    },
  } as never;

  return { client, tables, claims, preferences };
}
