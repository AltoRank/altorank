import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { normaliseDomain, checkDomainReachable } from "../reachable";

const lookup = vi.hoisted(() => vi.fn());
vi.mock("node:dns", () => ({ promises: { lookup } }));

const fetchMock = vi.fn();

beforeEach(() => {
  lookup.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("normaliseDomain", () => {
  it("strips scheme, www, path and case, like the workspace schema does", () => {
    expect(normaliseDomain("  https://www.Acme.com/pricing?x=1#top ")).toBe("acme.com");
    expect(normaliseDomain("HTTP://sub.Example.co.uk/")).toBe("sub.example.co.uk");
  });
});

describe("checkDomainReachable", () => {
  it("refuses a reserved TLD without ever asking DNS", async () => {
    // The case that started this: .test satisfies the hostname regex and can
    // never resolve for anyone, but a developer's /etc/hosts may answer it.
    const r = await checkDomainReachable("stripdemo.altorank.test");
    expect(r).toMatchObject({ ok: false, verdict: "no-dns" });
    expect(r.ok === false && r.reason).toContain("reserved");
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(["example", "invalid", "localhost", "local"])("also refuses .%s", async (tld) => {
    const r = await checkDomainReachable(`site.${tld}`);
    expect(r).toMatchObject({ ok: false, verdict: "no-dns" });
  });

  it("refuses a string that is not a hostname", async () => {
    for (const bad of ["not a domain", "acme", "", "http://"]) {
      expect(await checkDomainReachable(bad)).toMatchObject({ ok: false, verdict: "invalid" });
    }
  });

  it("blocks a domain that resolves to nothing", async () => {
    lookup.mockRejectedValue(new Error("ENOTFOUND"));
    const r = await checkDomainReachable("does-not-exist-9y3.com");
    expect(r).toMatchObject({ ok: false, verdict: "no-dns" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes a domain that resolves and answers", async () => {
    lookup.mockResolvedValue([{ address: "1.2.3.4", family: 4 }]);
    fetchMock.mockResolvedValue({ ok: true });
    const r = await checkDomainReachable("acme.com");
    expect(r).toEqual({ ok: true, verdict: "live", url: "https://acme.com" });
  });

  it("allows a domain that resolves but refuses our fetch, because a WAF is not a typo", async () => {
    // The judgement call that keeps real customers: blocking here would reject
    // every site behind Cloudflare that turns away unknown bots.
    lookup.mockResolvedValue([{ address: "1.2.3.4", family: 4 }]);
    fetchMock.mockRejectedValue(new Error("403"));
    const r = await checkDomainReachable("shy.com");
    expect(r).toMatchObject({ ok: true, verdict: "no-http" });
    // HEAD then GET, then give up rather than hammer the origin.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to GET when HEAD is refused", async () => {
    lookup.mockResolvedValue([{ address: "1.2.3.4", family: 4 }]);
    fetchMock.mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true });
    expect(await checkDomainReachable("acme.com")).toMatchObject({ verdict: "live" });
  });

  it("never throws, whatever DNS or fetch does", async () => {
    lookup.mockImplementation(() => {
      throw new Error("resolver exploded");
    });
    await expect(checkDomainReachable("acme.com")).resolves.toMatchObject({ ok: false });
  });
});
