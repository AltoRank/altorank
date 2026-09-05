// ---------------------------------------------------------------------------
// Keywords as a file
// ---------------------------------------------------------------------------
//
// One column list, one CSV renderer, used by GET /api/agent/v1/keywords/export
// and by the CLI when it renders the JSON envelope to CSV locally. Kept pure
// so both surfaces produce byte-identical output for the same rows.
//
// Numbers that were never measured are empty cells, not 0. A spreadsheet
// average over a column of zeros is a lie; over blanks it is a number.

export type ExportableKeyword = {
  id: string;
  term: string;
  volume: number | null;
  difficulty: number | null;
  cpc?: number | null;
  intent: string | null;
  status: string;
  planned_for?: string | null;
  created_at: string;
};

export const KEYWORD_EXPORT_COLUMNS = [
  "id",
  "term",
  "volume",
  "difficulty",
  "cpc",
  "intent",
  "status",
  "planned_for",
  "created_at",
] as const;

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  // RFC 4180: quote when the value contains a comma, a quote or a line break.
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function keywordsToCsv(rows: ExportableKeyword[]): string {
  const lines = [KEYWORD_EXPORT_COLUMNS.join(",")];
  for (const r of rows) {
    lines.push(KEYWORD_EXPORT_COLUMNS.map((c) => cell((r as Record<string, unknown>)[c])).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
