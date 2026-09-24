// Runs in the vitest `db` project (vitest.config.ts) before every test file,
// in the same process as the file, so it holds even for a db test that builds
// its own client straight from process.env instead of asking local-db.ts for
// one. By the time a test body runs, every database URL in the environment is
// on this machine, or the file has already failed with the name of the host it
// refused.
import { assertLocalEnv, loadLocalEnv } from "./local-db";

loadLocalEnv();
assertLocalEnv(process.env);
