// `npm run dev:e2e`: the e2e dev server, started by hand for a fast loop.
//
// Same port and the same environment overrides as the server
// playwright.config.ts starts (e2e/fixtures/server-env.ts), so a server left
// running for `npm run e2e` to reuse cannot reach a paid provider or hand the
// onboarding worker to another dev server.

import { spawn } from "node:child_process";
import { E2E_PORT, E2E_SERVER_ENV } from "../e2e/fixtures/server-env";

const child = spawn("npx", ["next", "dev", "-p", String(E2E_PORT)], {
  stdio: "inherit",
  env: { ...process.env, ...E2E_SERVER_ENV },
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
