import { describe, it, expect, vi } from "vitest";

// The socket is never opened here (the unit tier's network guard would refuse
// any name that is not this machine before resolution): node:https is
// replaced to capture the options siteFetch opens it with, and the lookup it
// was given is then called directly against a faked resolver.
const { captured, resolved } = vi.hoisted(() => ({
  captured: [] as Array<Record<string, unknown>>,
  resolved: { address: "10.1.2.3" },
}));

vi.mock("node:https", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:https")>();
  const request = (_url: unknown, opts: Record<string, unknown>) => {
    captured.push(opts);
    throw new Error("captured");
  };
  return { ...real, default: { ...real, request }, request };
});

vi.mock("node:dns", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:dns")>();
  const lookup = (_host: string, _opts: unknown, cb: (err: null, addrs: unknown) => void) =>
    cb(null, [{ address: resolved.address, family: 4 }]);
  return { ...real, default: { ...real, lookup }, lookup };
});

import { siteFetch } from "../site-fetch";
import { guardedLookup, UnsafeUrlError } from "@/lib/public-tools/safe-fetch";

type Lookup = (host: string, opts: object, cb: (err: Error | null, address?: unknown) => void) => void;

describe("siteFetch name resolution", () => {
  it("opens the socket through the guarded lookup", async () => {
    await expect(siteFetch("https://wp.example.test/wp-json/altorank/v1/test-integration", { method: "POST", body: "{}" })).rejects.toThrow(
      "captured",
    );
    expect(captured[0]?.lookup).toBe(guardedLookup);
  });

  it("that lookup refuses a public-looking name resolving to a private address, and passes a public one", async () => {
    const lookup = captured[0].lookup as Lookup;
    resolved.address = "10.1.2.3";
    const refused = await new Promise<Error | null>((r) => lookup("wp.example.test", {}, (err) => r(err)));
    expect(refused).toBeInstanceOf(UnsafeUrlError);

    resolved.address = "93.184.216.34";
    const allowed = await new Promise<unknown>((r) => lookup("wp.example.test", {}, (err, address) => r(err ?? address)));
    expect(allowed).toBe("93.184.216.34");
  });
});
