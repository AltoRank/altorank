// ---------------------------------------------------------------------------
// What a public tool returns: a list of display blocks
// ---------------------------------------------------------------------------
//
// The marketing site renders these with one generic component, so a new tool
// needs no front-end work: it picks from five shapes and fills them. Keep the
// union closed. A sixth shape is a change to every renderer that consumes
// this API, not a local decision inside one tool.
//
// Contract (POST /api/public/tools/<slug>):
//   200  { ok: true, data: { blocks: Block[] }, cached?: boolean }
//   4xx/5xx  { ok: false, error: string, code: ToolErrorCode }

export type BlockStatus = "pass" | "warn" | "fail" | "info";

export type TextBlock = { type: "text"; title?: string; text: string };
export type ListBlock = { type: "list"; title?: string; items: string[] };
export type TableCell = string | number | null;
export type TableBlock = { type: "table"; title?: string; columns: string[]; rows: TableCell[][] };
export type KvItem = { label: string; value: string; status?: BlockStatus };
export type KvBlock = { type: "kv"; title?: string; items: KvItem[] };
export type CodeBlock = { type: "code"; title?: string; language?: string; code: string };

export type Block = TextBlock | ListBlock | TableBlock | KvBlock | CodeBlock;

// Small builders. They exist so a tool reads as a list of results rather than
// a list of object literals, and so an optional title is dropped rather than
// serialised as `"title": undefined`.

export function text(textValue: string, title?: string): TextBlock {
  return title ? { type: "text", title, text: textValue } : { type: "text", text: textValue };
}

export function list(items: string[], title?: string): ListBlock {
  return title ? { type: "list", title, items } : { type: "list", items };
}

export function table(columns: string[], rows: TableCell[][], title?: string): TableBlock {
  return title ? { type: "table", title, columns, rows } : { type: "table", columns, rows };
}

export function kv(items: KvItem[], title?: string): KvBlock {
  return title ? { type: "kv", title, items } : { type: "kv", items };
}

export function code(codeValue: string, language?: string, title?: string): CodeBlock {
  const block: CodeBlock = { type: "code", code: codeValue };
  if (language) block.language = language;
  if (title) block.title = title;
  return block;
}

/** Worst status first: fail > warn > info > pass. For a summary line. */
export function worstStatus(statuses: Array<BlockStatus | undefined>): BlockStatus {
  const order: BlockStatus[] = ["fail", "warn", "info", "pass"];
  for (const s of order) if (statuses.includes(s)) return s;
  return "pass";
}
