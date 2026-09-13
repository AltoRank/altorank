import Link from "next/link";
import { requireAuth } from "@/lib/auth/require-auth";
import { cancelPendingCheckout } from "@/app/actions/cancel-checkout";

export default async function CheckoutCancelled() {
  const { role } = await requireAuth();
  return <main className="mx-auto max-w-xl px-6 py-16">
    <h1 className="mb-4 text-2xl font-semibold">Your draft and plan are saved</h1>
    <p className="mb-6">You left checkout. Close it to choose another plan, or return to your saved draft and resume the same trial options.</p>
    {role === "owner" && <form action={cancelPendingCheckout}><button className="mb-5 text-accent underline">Cancel checkout and return</button></form>}
    <Link className="text-accent underline" href="/onboarding?status=cancelled">Read my saved draft</Link>
  </main>;
}
