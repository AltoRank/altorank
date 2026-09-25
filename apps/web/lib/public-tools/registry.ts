// ---------------------------------------------------------------------------
// Every public tool, by slug
// ---------------------------------------------------------------------------
//
// POST /api/public/tools/<slug> looks the slug up here and nowhere else; a
// slug not in this list is a 404. To add a tool, write it under ./tools/ and
// add one line below (see ./README.md).

import type { PublicTool } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each tool has its own input type; the handler validates before calling run()
export type AnyPublicTool = PublicTool<any>;

const TOOLS: AnyPublicTool[] = [
  // fetch tools (free)
];

const BY_SLUG = new Map<string, AnyPublicTool>();
for (const tool of TOOLS) {
  if (BY_SLUG.has(tool.slug)) throw new Error(`Duplicate public tool slug: ${tool.slug}`);
  if (tool.kind === "fetch" && tool.estimateCents !== 0) {
    throw new Error(`Fetch tool ${tool.slug} must have estimateCents 0`);
  }
  BY_SLUG.set(tool.slug, tool);
}

export function getTool(slug: string): AnyPublicTool | undefined {
  return BY_SLUG.get(slug);
}

export function listTools(): AnyPublicTool[] {
  return [...BY_SLUG.values()];
}
