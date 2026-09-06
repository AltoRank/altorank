import { describe, it, expect } from "vitest";
import { CONNECTOR_NOTES } from "../connector-notes";
import { DRAFT_BEHAVIOUR } from "../publish-mode";

describe("CONNECTOR_NOTES", () => {
  it("has a paragraph for every connector the publish-mode table knows", () => {
    expect(Object.keys(CONNECTOR_NOTES).sort()).toEqual(Object.keys(DRAFT_BEHAVIOUR).sort());
  });

  it("every note is a real sentence and every source is an https vendor page", () => {
    for (const [type, note] of Object.entries(CONNECTOR_NOTES)) {
      expect(note.text.trim().length, type).toBeGreaterThan(40);
      expect(note.text.trim().endsWith("."), type).toBe(true);
      if (note.docUrl) {
        expect(note.docUrl, type).toMatch(/^https:\/\//);
        expect(note.docLabel, type).toBeTruthy();
      }
    }
  });

  it("states the Shopify scopes the adapter actually uses", () => {
    expect(CONNECTOR_NOTES.shopify.text).toContain("read_content and write_content");
  });
});
