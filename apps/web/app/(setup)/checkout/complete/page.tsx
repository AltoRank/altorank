import { requireAuth } from "@/lib/auth/require-auth";
import { CheckoutActivation } from "@/components/billing/checkout-activation";
import { checkoutDestination } from "@/lib/billing/checkout-return";

export default async function CheckoutComplete({ searchParams }: { searchParams: Promise<{ session_id?: string; next?: string }> }) {
  await requireAuth();
  const params = await searchParams;
  return <CheckoutActivation sessionId={params.session_id ?? ""} destination={checkoutDestination(params.next)} />;
}
