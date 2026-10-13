// ---------------------------------------------------------------------------
// The network boundary for vitest: a test only ever talks to this machine
// ---------------------------------------------------------------------------
//
// An env check at the top of a file can only look at the variables that are
// there when it runs. It cannot see a test that reads `.env.local` itself and
// hands the URL straight to createClient (which is exactly what the two old
// isolation suites did), a test that sets process.env after setup, or a unit
// test whose code path writes to whatever Supabase happens to be exported in
// the shell. All three were shown to reach a hosted URL with the env guard
// green. What they have in common is the connection, so that is where this
// guard sits: every `fetch` and every TCP or TLS socket the test process opens
// goes through it, whoever built the client and wherever the URL came from.
//
// Two modes, one per vitest project:
//
// - "loopback" (the db tier): anything on this machine is allowed, which is
//   the local Supabase and nothing else a db test needs. A hosted database, a
//   paid provider or a production callback URL is refused, whatever keys the
//   environment holds.
// - "own-servers" (the unit tier): nothing is allowed except a server this
//   same process is listening on (a test that starts a fixture HTTP server on
//   port 0 still works). The unit tier is mocks only; a test that opens a
//   connection to anything else, the local Supabase included, is a db test
//   with the wrong name, and it fails here instead of passing on a laptop and
//   skipping green in CI.
//
// A refused connection fails the way a dead host does (fetch rejects, the
// socket emits an error), so no request leaves the machine. Callers in the app
// often swallow that error (recordEvent returns false, fire-and-forget writes
// log and carry on), so every refusal is also recorded, and the setup files
// fail the test file in afterAll when any were: a refusal nobody noticed is
// still a failure.
//
// No vitest imports here, so the decision is unit-tested as a plain function.

import net from "node:net";
import { isLoopbackHost } from "./local-db";

export type GuardMode = "loopback" | "own-servers";

export type Refusal = { via: "fetch" | "socket"; host: string; port: number | undefined; reason: string };

type GuardState = {
  mode: GuardMode;
  refusals: Refusal[];
  /** Ports this process is listening on, for "own-servers". */
  ownPorts: Set<number>;
};

// On globalThis rather than in a module variable: vitest may evaluate this
// module more than once in one process (a setup file and a test importing it
// resolve to separate module instances in some pool modes), and there must be
// exactly one set of patched prototypes and one list of refusals.
const STATE_KEY = Symbol.for("altorank.test.networkGuard");

function state(): GuardState | undefined {
  return (globalThis as { [STATE_KEY]?: GuardState })[STATE_KEY];
}

/**
 * Why a connection to `host:port` is refused under `mode`, or null when it may
 * go ahead. Pure: the whole policy, tested without opening anything.
 */
export function refusalReason(
  mode: GuardMode,
  host: string,
  port: number | undefined,
  ownPorts: ReadonlySet<number>,
): string | null {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!isLoopbackHost(bare) && !isLoopbackHost(host)) {
    return (
      `${host} is not on this machine. Tests only ever talk to this machine; a hosted database, a paid ` +
      `provider or a production URL is refused whatever keys the environment holds.`
    );
  }
  if (mode === "own-servers" && (port === undefined || !ownPorts.has(port))) {
    return (
      `the unit tier opens no connections except to a server the test itself started, and nothing in ` +
      `this process is listening on ${host}:${port ?? "?"}. A test that needs the local Supabase is a ` +
      `*.db.test.ts and runs with \`npm run test:db\`; anything else should be mocked.`
    );
  }
  return null;
}

function refuse(s: GuardState, via: Refusal["via"], host: string, port: number | undefined, reason: string): Error {
  s.refusals.push({ via, host, port, reason });
  const err = new Error(`Network guard refused a connection to ${host}${port ? `:${port}` : ""} (${via}): ${reason}`);
  (err as NodeJS.ErrnoException).code = "ERR_TEST_NETWORK_GUARD";
  return err;
}

/** Where a fetch is going, or null when it goes nowhere on the network (data:, blob:) or is not a URL. */
function fetchTarget(input: unknown): { host: string; port: number } | null {
  const raw =
    typeof input === "string" ? input : input instanceof URL ? input.href : (input as { url?: unknown } | null)?.url;
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Not absolute: fetch itself rejects it, and nothing is opened.
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return { host: url.hostname, port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80 };
}

/**
 * Where a socket is connecting, from the arguments `net.Socket#connect` takes
 * (options object, `(port, host)`, a pipe path, or the pre-normalised array
 * `net.connect` passes). Null for a Unix socket or named pipe, which is on
 * this machine by definition.
 */
function socketTarget(args: unknown[]): { host: string; port: number | undefined } | null {
  const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  if (first !== null && typeof first === "object") {
    const options = first as { path?: unknown; host?: unknown; port?: unknown };
    if (typeof options.path === "string" && options.path) return null;
    return {
      host: typeof options.host === "string" && options.host ? options.host : "localhost",
      port: options.port === undefined ? undefined : Number(options.port),
    };
  }
  if (typeof first === "string" && Number.isNaN(Number(first))) return null;
  return { host: typeof args[1] === "string" && args[1] ? args[1] : "localhost", port: Number(first) };
}

/**
 * Patches fetch, net.Socket#connect (which TLS sockets, http.Agent and
 * undici all go through) and net.Server#listen for this process. Idempotent:
 * a second call switches the mode and starts a fresh list of refusals.
 */
export function installNetworkGuard(mode: GuardMode): void {
  const existing = state();
  if (existing) {
    existing.mode = mode;
    existing.refusals = [];
    return;
  }
  const s: GuardState = { mode, refusals: [], ownPorts: new Set() };
  (globalThis as { [STATE_KEY]?: GuardState })[STATE_KEY] = s;

  const realFetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input: Parameters<typeof fetch>[0], init?: RequestInit) {
    const target = fetchTarget(input);
    if (target) {
      const reason = refusalReason(s.mode, target.host, target.port, s.ownPorts);
      if (reason) return Promise.reject(refuse(s, "fetch", target.host, target.port, reason));
    }
    return realFetch(input, init);
  } as typeof fetch;

  const socketProto = net.Socket.prototype as unknown as { connect: (...args: unknown[]) => net.Socket };
  const realConnect = socketProto.connect;
  socketProto.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
    const target = socketTarget(args);
    if (target) {
      const reason = refusalReason(s.mode, target.host, target.port, s.ownPorts);
      if (reason) {
        const err = refuse(s, "socket", target.host, target.port, reason);
        // Asynchronously, the way a refused connection reports itself, so
        // every client's existing error handling sees an ordinary failure.
        process.nextTick(() => this.destroy(err));
        return this;
      }
    }
    return realConnect.apply(this, args);
  };

  const serverProto = net.Server.prototype as unknown as { listen: (...args: unknown[]) => net.Server };
  const realListen = serverProto.listen;
  serverProto.listen = function guardedListen(this: net.Server, ...args: unknown[]) {
    this.once("listening", () => {
      const address = this.address();
      if (address && typeof address === "object") {
        const port = address.port;
        s.ownPorts.add(port);
        this.once("close", () => s.ownPorts.delete(port));
      }
    });
    return realListen.apply(this, args);
  };
}

/** The refusals recorded since the guard was installed (or last drained), and clears them. */
export function drainRefusals(): Refusal[] {
  const s = state();
  if (!s) return [];
  const out = s.refusals;
  s.refusals = [];
  return out;
}

/** Throws, listing every refusal, when the file under test tried to leave the machine. For afterAll. */
export function assertNoRefusals(): void {
  const refused = drainRefusals();
  if (refused.length === 0) return;
  const lines = refused.map((r) => `  - ${r.host}${r.port ? `:${r.port}` : ""} via ${r.via}: ${r.reason}`);
  throw new Error(
    `This test file tried to open ${refused.length} connection(s) the network guard refused ` +
      `(lib/__tests__/support/network-guard.ts). Each one failed like a dead host, and the ` +
      `code under test may have swallowed that, so the file fails here instead:\n${lines.join("\n")}`,
  );
}
