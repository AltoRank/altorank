import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  INTEGRATION_DESCRIPTIONS,
  UNIMPLEMENTED_FEATURE_NOUNS,
} from "../integration-descriptions";

const MIGRATION = join(__dirname, "../../../supabase/migrations/065_integration_tile_copy.sql");
const ADAPTER_DIR = join(__dirname, "..");

describe("INTEGRATION_DESCRIPTIONS", () => {
  it("names no feature the adapters do not implement", () => {
    // P0-C6: six tiles advertised collections, metafields, feature images,
    // members visibility, covers, tags and template binding. None of those
    // words appears in any adapter payload.
    for (const [id, text] of Object.entries(INTEGRATION_DESCRIPTIONS)) {
      for (const noun of UNIMPLEMENTED_FEATURE_NOUNS) {
        expect(text.toLowerCase(), `${id}: "${text}"`).not.toContain(noun);
      }
    }
  });

  it("is a short sentence fragment for every connector", () => {
    for (const [id, text] of Object.entries(INTEGRATION_DESCRIPTIONS)) {
      expect(text.trim().length, id).toBeGreaterThan(20);
      expect(text.length, id).toBeLessThan(120);
      expect(text.trim().endsWith("."), id).toBe(false);
    }
  });

  it("the migration writes exactly these strings", () => {
    // One source of truth: a description changed in code and not in the
    // migration would never reach a tile.
    const sql = readFileSync(MIGRATION, "utf8");
    for (const [id, text] of Object.entries(INTEGRATION_DESCRIPTIONS)) {
      expect(sql, id).toContain(`'${text}'`);
      expect(sql, id).toContain(`where id = '${id}'`);
    }
  });

  it("claims nothing about a payload field its adapter never sends", () => {
    // A coarse but real check: the tile that says "tags" must come from an
    // adapter whose file mentions tags.
    const files: Record<string, string> = {
      wordpress: "wordpress.ts",
      woocommerce: "wordpress.ts",
      shopify: "shopify.ts",
      ghost: "ghost.ts",
      framer: "framer.ts",
    };
    for (const [id, file] of Object.entries(files)) {
      if (!/tags/i.test(INTEGRATION_DESCRIPTIONS[id])) continue;
      const source = readFileSync(join(ADAPTER_DIR, file), "utf8");
      expect(source, `${id} claims tags`).toMatch(/tags/);
    }
  });
});
