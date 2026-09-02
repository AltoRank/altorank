import { describe, it, expect, afterEach } from "vitest";
import { cronSecretFrom, isAuthorizedCron } from "../cron-auth";

describe("cron auth", () => {
  const prev = process.env.CRON_SECRET;
  afterEach(() => { process.env.CRON_SECRET = prev; });

  it("accepts Vercel's Authorization: Bearer header and the manual x-cron-secret header", () => {
    process.env.CRON_SECRET = "s3cret";
    expect(isAuthorizedCron(new Request("https://x/api/cron/a", { headers: { authorization: "Bearer s3cret" } }))).toBe(true);
    expect(isAuthorizedCron(new Request("https://x/api/cron/a", { headers: { "x-cron-secret": "s3cret" } }))).toBe(true);
    expect(isAuthorizedCron(new Request("https://x/api/cron/a", { headers: { authorization: "Bearer wrong" } }))).toBe(false);
    expect(isAuthorizedCron(new Request("https://x/api/cron/a"))).toBe(false);
  });

  it("refuses everything when no secret is configured", () => {
    delete process.env.CRON_SECRET;
    expect(isAuthorizedCron(new Request("https://x/api/cron/a", { headers: { authorization: "Bearer " } }))).toBe(false);
    expect(cronSecretFrom(new Request("https://x/a", { headers: { authorization: "Basic abc" } }))).toBeNull();
  });
});
