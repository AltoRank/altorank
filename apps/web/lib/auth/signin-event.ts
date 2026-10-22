import { recordEvent } from "@/lib/observability/record";

/**
 * How people sign in, counted: a typed code, a password, or the one-click
 * link in the code email. Nothing counted sign-ins before, so whether code
 * sign-in is what returning owners use could not be read anywhere. The user
 * id and the method only. Awaited by callers that redirect next (a redirect
 * throws); never throws itself (lib/observability/record.ts).
 */
export async function recordSignIn(method: "code" | "password" | "link", userId: string | null | undefined): Promise<void> {
  await recordEvent({
    level: "info",
    source: "signin",
    message: `Signed in with ${method === "code" ? "a code" : method === "password" ? "a password" : "the emailed link"}`,
    context: { method, ...(userId ? { userId } : {}) },
  });
}
