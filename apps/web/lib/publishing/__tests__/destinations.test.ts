import { describe, expect, it } from "vitest";
import { chooseDestination, toDestinations, type Destination } from "../destinations";

const wp: Destination = { id: "wi-wp", integrationId: "wordpress", label: "WordPress", type: "wordpress" };
const ghost: Destination = { id: "wi-ghost", integrationId: "ghost", label: "Ghost", type: "ghost" };

describe("toDestinations", () => {
  it("keeps CMS connections and drops analytics ones", () => {
    const out = toDestinations([
      { id: "a", config: { type: "wordpress" }, integration: { id: "wordpress", name: "WordPress", tag: "CMS" } },
      { id: "b", config: { type: "gsc" }, integration: { id: "gsc", name: "Search Console", tag: "Analytics" } },
    ]);
    expect(out.map((d) => d.id)).toEqual(["a"]);
    expect(out[0]).toMatchObject({ integrationId: "wordpress", label: "WordPress", type: "wordpress" });
  });

  it("reads the adapter type from the config, falling back to the integration id", () => {
    const out = toDestinations([
      // The type is stored in the clear beside the encrypted secrets, so it
      // reads without a key; a row with no type is filed under its integration.
      { id: "a", config: { __encrypted: true, type: "git", token: "ciphertext" }, integration: { id: "git", name: "Git", tag: "CMS" } },
      { id: "b", config: { url: "https://hooks.example" }, integration: { id: "webhook", name: "Webhook", tag: "CMS" } },
      { id: "c", config: null, integration: { id: "ghost", name: "Ghost", tag: "CMS" } },
    ]);
    expect(out.map((d) => d.type)).toEqual(["git", "webhook", "ghost"]);
  });

  it("is empty for nothing connected", () => {
    expect(toDestinations(null)).toEqual([]);
    expect(toDestinations([])).toEqual([]);
  });
});

describe("chooseDestination", () => {
  it("refuses with the message callers match on when nothing is connected", () => {
    expect(() => chooseDestination([], { cms: null })).toThrow("No CMS integration connected for this workspace");
  });

  it("honours a requested destination that belongs to the workspace", () => {
    expect(chooseDestination([wp, ghost], { cms: null }, "wi-ghost")).toBe(ghost);
  });

  it("refuses a requested destination from somewhere else, rather than falling back", () => {
    // The id comes through the browser. Silently publishing to the first
    // connection would be the exact wrong-destination bug this replaces.
    expect(() => chooseDestination([wp, ghost], { cms: null }, "wi-someone-elses")).toThrow(
      "not connected to this workspace",
    );
  });

  it("goes back to where the article already went", () => {
    expect(chooseDestination([wp, ghost], { cms: "ghost" })).toBe(ghost);
  });

  it("falls back to the first connection, which is what the scheduler picks", () => {
    expect(chooseDestination([wp, ghost], { cms: null })).toBe(wp);
    expect(chooseDestination([wp, ghost], { cms: "shopify" })).toBe(wp);
  });
});
