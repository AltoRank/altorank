// Runs in the vitest `unit` project (vitest.config.ts) before every test file,
// in the same process as the file.
//
// The unit tier is mocks only and is meant to behave the same on every machine
// as it does in CI's build job, which exports no database at all. Three steps:
//
// 1. A production database URL exported in the shell (a sourced .env.local,
//    direnv) is refused loudly, naming the host. Nothing in the unit tier
//    needs one, and the same shell would also point `next dev` at it, since a
//    shell value wins over every env file.
// 2. Whatever database variables are left (a local stack's, say) are removed,
//    so a code path that writes to "whatever Supabase is configured" (the
//    observability recorder does) finds none here, exactly as in CI, instead
//    of quietly writing to the local stack on one laptop and not another.
// 3. The network guard in "own-servers" mode: no connection leaves this
//    process except to a server the test started. A test that needs a real
//    database is a *.db.test.ts, and one that is not named that way fails here
//    rather than passing locally and skipping green in CI.
import { afterAll } from "vitest";
import { assertLocalEnv, DATABASE_URL_VARS, LOCAL_STACK_VARS } from "./local-db";
import { assertNoRefusals, installNetworkGuard } from "./network-guard";

assertLocalEnv(process.env);
for (const name of new Set<string>([...DATABASE_URL_VARS, ...LOCAL_STACK_VARS])) {
  Reflect.deleteProperty(process.env, name);
}
installNetworkGuard("own-servers");
afterAll(assertNoRefusals);
