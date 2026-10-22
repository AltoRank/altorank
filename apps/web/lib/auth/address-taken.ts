// ---------------------------------------------------------------------------
// A signup for an address that already has an account
// ---------------------------------------------------------------------------
//
// Supabase refuses the signup link for a confirmed address with "A user with
// this email address has already been registered", and the signup form used
// to show that sentence and stop. The person is a returning owner who typed
// their address on the wrong form, and since code signup (#287) most of them
// have no password they know. So the signup action tells this refusal apart
// from the others and offers a sign-in code instead (app/(auth)/signup).
//
// An unconfirmed address is not refused: `generateLink({ type: "signup" })`
// returns the existing user, and the signup carries on (./signup-reuse.ts).

/** Thrown by `sendSignupConfirmation` when the address already has a confirmed user. Its message is Supabase's. */
export class AddressTakenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AddressTakenError";
  }
}

/** Whether Supabase's refusal of a signup link means the address is taken. */
export function isAddressTakenRefusal(error: { code?: string | null; message?: string | null }): boolean {
  if (error.code === "email_exists" || error.code === "user_already_exists") return true;
  return /already (been )?registered/i.test(error.message ?? "");
}

export function isAddressTaken(e: unknown): e is AddressTakenError {
  return e instanceof AddressTakenError;
}
