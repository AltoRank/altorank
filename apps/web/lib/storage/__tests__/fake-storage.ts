/**
 * A storage stand-in shaped like supabase-js: `storage.from(bucket).list()`
 * returns the immediate children of a folder (files with an id, folders
 * without), paged by `limit`/`offset`; `remove()` deletes exact paths.
 * `from("articles")` answers the paged article read in lib/storage/purge.ts.
 */
export function fakeStorage(seed: Record<string, string[]>, articles: Record<string, unknown>[] = []) {
  const buckets = new Map(Object.entries(seed).map(([b, paths]) => [b, new Set(paths)]));
  const removed: { bucket: string; paths: string[] }[] = [];
  const lists: { bucket: string; prefix: string }[] = [];

  function children(bucket: string, prefix: string) {
    const base = prefix.replace(/\/+$/, "");
    const seen = new Map<string, { name: string; id: string | null }>();
    for (const path of buckets.get(bucket) ?? []) {
      if (!path.startsWith(`${base}/`)) continue;
      const rest = path.slice(base.length + 1);
      const [head, ...tail] = rest.split("/");
      if (!seen.has(head)) seen.set(head, { name: head, id: tail.length ? null : `obj-${path}` });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  const client = {
    storage: {
      from: (bucket: string) => ({
        list: async (prefix: string, opts: { limit?: number; offset?: number } = {}) => {
          lists.push({ bucket, prefix });
          const all = children(bucket, prefix);
          const offset = opts.offset ?? 0;
          return { data: all.slice(offset, offset + (opts.limit ?? 100)), error: null };
        },
        remove: async (paths: string[]) => {
          removed.push({ bucket, paths: [...paths] });
          for (const p of paths) buckets.get(bucket)?.delete(p);
          return { data: paths.map((name) => ({ name })), error: null };
        },
      }),
    },
    from: () => {
      const filters: Record<string, unknown> = {};
      let range: [number, number] = [0, 999];
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        select: () => q,
        order: () => q,
        eq: (k: string, v: unknown) => {
          filters[k] = v;
          return q;
        },
        range: (from: number, to: number) => {
          range = [from, to];
          return q;
        },
        then: (resolve: (v: unknown) => unknown) => {
          const rows = articles.filter((a) => Object.entries(filters).every(([k, v]) => a[k] === v));
          return resolve({ data: rows.slice(range[0], range[1] + 1), error: null });
        },
      });
      return q;
    },
  };

  return {
    client: client as never,
    removed,
    lists,
    has: (bucket: string, path: string) => buckets.get(bucket)?.has(path) ?? false,
    paths: (bucket: string) => [...(buckets.get(bucket) ?? [])].sort(),
  };
}
