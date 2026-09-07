import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scopeShouldMove } from "../scope-follow";

// No DOM in this test runner, so the effect is not exercised; the decision it
// acts on is, and the mounts are pinned by reading the two pages.

describe("scopeShouldMove", () => {
  const visible = ["ws-a", "ws-b"];
  it("moves the scope to the page's site when the cookie names another one", () => {
    expect(scopeShouldMove("ws-a", visible, "ws-b")).toBe(true);
  });
  it("does nothing when the scope already matches", () => {
    expect(scopeShouldMove("ws-b", visible, "ws-b")).toBe(false);
  });
  it("leaves the scope alone for a site the account cannot see", () => {
    expect(scopeShouldMove("ws-a", visible, "ws-foreign")).toBe(false);
  });
  it("moves when there is no scope yet", () => {
    expect(scopeShouldMove(null, visible, "ws-a")).toBe(true);
  });
});

describe("the detail pages tell the scope which site they are about", () => {
  const app = join(__dirname, "..", "..", "..", "app", "(dashboard)");
  for (const [page, prop] of [
    ["content/[id]/page.tsx", "workspace.id"],
    ["improvements/[id]/page.tsx", "execution.workspace_id"],
  ] as const) {
    it(`${page} mounts ScopeFollow with the row's workspace`, () => {
      const src = readFileSync(join(app, page), "utf8");
      expect(src).toContain('from "@/components/dashboard/scope-follow"');
      expect(src).toContain(`<ScopeFollow workspaceId={${prop}} />`);
    });
  }
});
