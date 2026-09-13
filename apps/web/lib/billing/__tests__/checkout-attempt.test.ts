import { beforeEach, expect, it, vi } from "vitest";
const { rpc, create, retrieve, subscriptions, update } = vi.hoisted(() => ({rpc:vi.fn(),create:vi.fn(),retrieve:vi.fn(),subscriptions:vi.fn(),update:vi.fn()}));
vi.mock("@/lib/stripe", () => ({getStripe:()=>({checkout:{sessions:{create,retrieve}},subscriptions:{retrieve:subscriptions}})}));
vi.mock("@/lib/supabase/server", () => ({createServiceClient:()=>({rpc,from:()=>({update})})}));
import { createPendingCheckout } from "../checkout-attempt";
const parameters = {mode:"subscription" as const,line_items:[{price:"price_1",quantity:1}],client_reference_id:"account"};
beforeEach(() => {
  vi.resetAllMocks();
  rpc.mockResolvedValue({data:[{id:"attempt-one",parameters:{...parameters,expires_at:12345}}]});
  create.mockResolvedValue({id:"cs_one",url:"https://checkout.stripe.com/test",status:"open"});
  const q = {eq:()=>q,then:(resolve:(v:unknown)=>unknown)=>resolve({error:null})};
  update.mockReturnValue(q);
});
it("reuses the durable idempotency key and frozen parameters on retries", async () => {
  await createPendingCheckout("account",parameters); await createPendingCheckout("account",parameters);
  expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
  expect(create.mock.calls[0][1]).toEqual({idempotencyKey:"checkout:attempt-one"});
  expect(create.mock.calls[0][0].expires_at).toBe(12345);
});
it("does not open another checkout while a different price is pending", async () => {
  await expect(createPendingCheckout("account",{...parameters,line_items:[{price:"price_2"}]})).rejects.toThrow("another plan");
  expect(create).not.toHaveBeenCalled();
});
it("does not call Stripe if the reservation cannot be persisted", async () => {
  rpc.mockResolvedValue({data:null,error:{message:"db down"}});
  await expect(createPendingCheckout("account",parameters)).rejects.toThrow("reserved"); expect(create).not.toHaveBeenCalled();
});
it("resumes a completed active subscription rather than starting another", async () => {
  rpc.mockResolvedValue({data:[{id:"attempt-one",parameters,stripe_session_id:"cs_one"}]});
  retrieve.mockResolvedValue({id:"cs_one",client_reference_id:"account",status:"complete",subscription:"sub_one"});
  subscriptions.mockResolvedValue({status:"trialing"});
  expect(await createPendingCheckout("account",parameters)).toMatchObject({status:"complete"});
  expect(create).not.toHaveBeenCalled();
});
