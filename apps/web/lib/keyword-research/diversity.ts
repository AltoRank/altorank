/** Round-robin source allocation preserves each source's internal ranking. */
export function balanceSources<T>(rows: T[], key: (row: T) => string | number): T[] {
  const groups = new Map<string | number, T[]>();
  for (const row of rows) { const source = key(row); const group = groups.get(source) ?? []; group.push(row); groups.set(source, group); }
  const out: T[] = [];
  const size = Math.max(0, ...[...groups.values()].map((g) => g.length));
  for (let i = 0; i < size; i++) for (const group of groups.values()) if (i < group.length) out.push(group[i]);
  return out;
}
export function diverseSeeds(terms: string[], limit: number): string[] {
  if (limit <= 0) return [];
  const selected: string[] = [];
  const tokens = (term: string) => new Set(term.toLowerCase().split(/\s+/));
  for (const term of terms) {
    const candidate = tokens(term);
    if (selected.some((other) => { const set = tokens(other); return [...candidate].filter((word) => set.has(word)).length / new Set([...candidate, ...set]).size >= 0.65; })) continue;
    selected.push(term);
    if (selected.length === limit) break;
  }
  return selected;
}
