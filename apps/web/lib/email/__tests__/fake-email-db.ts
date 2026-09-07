// A `sent_emails` + `email_preferences` pair that behaves like the real ones.
//
// The primary key (email_type, subject_id, recipient) rejects a second claim
// with 23505, which is the whole send-once mechanism, and a failed send deletes
// its claim again. Shared by every test of a sendOnce caller so they all agree
// on what the database does; the alternative is each one inventing a slightly
// different Postgres.

export type FakeEmailDb = {
  client: never;
  /** Rows successfully claimed, in order. */
  inserted: Record<string, unknown>[];
  /** "type|subjectId|recipient" for each claim released after a failed send. */
  deleted: string[];
  claims: Set<string>;
};

export function fakeEmailDb(
  opts: { preferences?: Record<string, string[]>; claimError?: string; prefsError?: string } = {},
): FakeEmailDb {
  const claims = new Set<string>();
  const inserted: Record<string, unknown>[] = [];
  const deleted: string[] = [];

  const client = {
    from(table: string) {
      if (table === "email_preferences") {
        return {
          select: () => ({
            in: async (_col: string, emails: string[]) => {
              if (opts.prefsError) return { data: null, error: { message: opts.prefsError } };
              return {
                data: emails
                  .filter((e) => opts.preferences?.[e])
                  .map((e) => ({ email: e, unsubscribed: opts.preferences![e] })),
                error: null,
              };
            },
          }),
        };
      }
      if (table === "sent_emails") {
        return {
          insert: async (row: Record<string, unknown>) => {
            if (opts.claimError) return { error: { code: "42501", message: opts.claimError } };
            const key = `${row.email_type}|${row.subject_id}|${row.recipient}`;
            if (claims.has(key)) return { error: { code: "23505", message: "duplicate key" } };
            claims.add(key);
            inserted.push(row);
            return { error: null };
          },
          delete: () => {
            const filters: string[] = [];
            const chain = {
              eq(_col: string, val: string) {
                filters.push(val);
                if (filters.length === 3) {
                  claims.delete(filters.join("|"));
                  deleted.push(filters.join("|"));
                  return Promise.resolve({ error: null });
                }
                return chain;
              },
            };
            return chain;
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as never;

  return { client, inserted, deleted, claims };
}
