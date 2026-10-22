import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const { auth, retrieve, read, subscription, activate } = vi.hoisted(() => ({ auth: vi.fn(), retrieve: vi.fn(), read: vi.fn(), subscription: vi.fn(), activate: vi.fn() }));
vi.mock("@/lib/auth/require-auth", () => ({ requireAuth: auth }));
vi.mock("@/lib/stripe", async (importOriginal) => ({ ...(await importOriginal<object>()), getStripe: () => ({checkout:{sessions:{retrieve}}}) }));
vi.mock("@/lib/supabase/server", () => ({createClient:async()=>({from:()=>({select:()=>({eq:()=>({single:read})})})}),createServiceClient:()=>({})}));
// The return page records a completed checkout itself (app/api/billing/checkout-status/__tests__);
// here Stripe still holds the subscription as `incomplete`, which it leaves to the webhook.
vi.mock("@/lib/billing/activate-checkout", async (importOriginal) => ({ ...(await importOriginal<object>()), readCheckoutSubscription: subscription, activateCheckout: activate }));
import { GET } from "@/app/api/billing/checkout-status/route";
import { checkoutDestination } from "../checkout-return";
const request = () => new NextRequest("https://app.test/api/billing/checkout-status?session_id=cs_test_123");
beforeEach(() => {
  vi.resetAllMocks();
  auth.mockResolvedValue({accountId:"account"});
  retrieve.mockResolvedValue({id:"cs_test_123",client_reference_id:"account",status:"complete",subscription:"sub_1"});
  read.mockResolvedValue({data:{plan_status:"trialing",stripe_subscription_id:"sub_1",trial_ends_at:new Date(Date.now()+86_400_000).toISOString()}});
  subscription.mockResolvedValue({id:"sub_1",customer:"cus_1",status:"incomplete",metadata:{}});
});
it("opens access only after the matching subscription is activated", async () => {
  expect(await (await GET(request())).json()).toMatchObject({active:true});
});
it("does not unlock on a successful return while the subscription is not running yet", async () => {
  read.mockResolvedValue({data:{plan_status:"inactive",stripe_subscription_id:null}});
  expect(await (await GET(request())).json()).toMatchObject({status:"complete",active:false});
  expect(activate).not.toHaveBeenCalled();
});
it("does not use another account's checkout", async () => {
  retrieve.mockResolvedValue({client_reference_id:"other"});
  expect((await GET(request())).status).toBe(404); expect(read).not.toHaveBeenCalled();
});
it("does not accept an unrelated old subscription", async () => {
  read.mockResolvedValue({data:{plan_status:"active",stripe_subscription_id:"sub_other"}});
  expect(await (await GET(request())).json()).toMatchObject({active:false});
});
it("does not unlock an expired trial from a stale status", async () => {
  read.mockResolvedValue({data:{plan_status:"trialing",stripe_subscription_id:"sub_1",trial_ends_at:"2020-01-01"}});
  expect(await (await GET(request())).json()).toMatchObject({active:false});
});
it("rejects unauthenticated status reads", async () => {
  auth.mockRejectedValue(new Error("unauthenticated")); expect((await GET(request())).status).toBe(401); expect(retrieve).not.toHaveBeenCalled();
});
it("reports a provider outage without granting access", async () => {
  retrieve.mockRejectedValue(new Error("offline")); expect((await GET(request())).status).toBe(503);
});
it("permits only local return destinations", () => {
  for (const value of ["https://evil.test", "//evil.test", "/%2fevil.test", "/%5cevil.test", "/%xx"]) expect(checkoutDestination(value)).toBe("/dashboard");
  expect(checkoutDestination("/articles?status=review")).toBe("/articles?status=review");
});
