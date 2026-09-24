// Runs in the vitest `db` project (vitest.config.ts) before every test file,
// in the same process as the file.
//
// The network guard goes on first and is the boundary: in "loopback" mode it
// refuses every connection that is not to this machine, so a db test that
// finds a URL some other way (reads an env file itself, sets process.env after
// this file, builds its own client) still cannot reach a hosted database, and
// a code path that reaches for a paid provider fails instead of spending. A
// refusal the code under test swallowed still fails the file, in afterAll.
//
// The env check is the readable failure: it names the variable and the host
// before any test body runs, instead of leaving the first refused request to
// explain it.
import { afterAll } from "vitest";
import { assertLocalEnv, loadLocalEnv } from "./local-db";
import { assertNoRefusals, installNetworkGuard } from "./network-guard";

installNetworkGuard("loopback");
afterAll(assertNoRefusals);
loadLocalEnv();
assertLocalEnv(process.env);
