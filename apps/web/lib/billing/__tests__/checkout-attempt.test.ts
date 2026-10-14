import { beforeEach, expect, it, vi } from "vitest";
const { rpc, create, retrieve, expire, subscriptions, update, deletes } = vi.hoisted(() => ({rpc:vi.fn(),create:vi.fn(),retrieve:vi.fn(),expire:vi.fn(),subscriptions:vi.fn(),update:vi.fn(),deletes:[] as Array<Array<[string, string, unknown]>>}));
vi.mock("@/lib/stripe", () => ({getStripe:()=>({checkout:{sessions:{create,retrieve,expire}},subscriptions:{retrieve:subscriptions}})}));
/** A delete builder that records its filters and resolves with no error. */
function deleteQuery() {
  const filters: Array<[string, string, unknown]> = [];
  deletes.push(filters);
  const q = {eq:(c:string,v:unknown)=>(filters.push(["eq",c,v]),q),is:(c:string,v:unknown)=>(filters.push(["is",c,v]),q),then:(resolve:(v:unknown)=>unknown)=>resolve({error:null})};
  return q;
}
vi.mock("@/lib/supabase/server", () => ({createServiceClient:()=>({rpc,from:()=>({update,delete:deleteQuery})})}));
import { attemptAbandoned, createPendingCheckout, ABANDONED_ATTEMPT_MS, CHECKOUT_TTL_SECONDS } from "../checkout-attempt";
const parameters = {mode:"subscription" as const,line_items:[{price:"price_1",quantity:1}],client_reference_id:"account"};
/** An attempt reserved `ageMs` ago: `expires_at` is the reservation time plus the session's hour. */
const reservedAgo = (ageMs: number) => new Date(Date.now() - ageMs + CHECKOUT_TTL_SECONDS * 1000).toISOString();
beforeEach(() => {
  vi.resetAllMocks();
  deletes.length = 0;
  rpc.mockResolvedValue({data:[{id:"attempt-one",expires_at:reservedAgo(1000),parameters:{...parameters,expires_at:12345}}]});
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
it("does not open a second checkout while another price is still being opened", async () => {
  await expect(createPendingCheckout("account",{...parameters,line_items:[{price:"price_2"}]})).rejects.toThrow("still opening");
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

// The lockout: a create that threw left its reservation with no session, and
// every retry replayed the same request - and from half an hour on, Stripe
// refused its frozen `expires_at` as too close. The account could never pay.
it("releases the reservation when Stripe refuses the create, so the next press starts fresh", async () => {
  create.mockRejectedValueOnce(new Error("Stripe is down"));
  await expect(createPendingCheckout("account",parameters)).rejects.toThrow("Stripe is down");
  expect(deletes).toHaveLength(1);
  // Only while it still has no session: a parallel create that saved one is kept.
  expect(deletes[0]).toEqual([["eq","account_id","account"],["eq","id","attempt-one"],["is","stripe_session_id",null]]);
});
it("keeps the reservation when the refusal is a concurrent create under the same key", async () => {
  // A double click: the first create is still running and will save its
  // session on this row. Releasing it would let a third press open a second
  // checkout beside the first.
  create.mockRejectedValueOnce(Object.assign(new Error("Keys for idempotent requests can only be used ..."), {code:"idempotency_key_in_use"}));
  await expect(createPendingCheckout("account",parameters)).rejects.toThrow("idempotent");
  expect(deletes).toHaveLength(0);
});
it("treats a reservation that never got a session as abandoned after a few minutes, and starts over", async () => {
  rpc.mockResolvedValueOnce({data:[{id:"attempt-old",expires_at:reservedAgo(ABANDONED_ATTEMPT_MS + 1000),parameters:{...parameters,expires_at:1}}]})
    .mockResolvedValueOnce({data:[{id:"attempt-new",expires_at:reservedAgo(0),parameters:{...parameters,expires_at:99999}}]});
  await createPendingCheckout("account",parameters);
  expect(deletes[0]).toContainEqual(["eq","id","attempt-old"]);
  expect(create).toHaveBeenCalledOnce();
  expect(create.mock.calls[0][1]).toEqual({idempotencyKey:"checkout:attempt-new"});
  expect(create.mock.calls[0][0].expires_at).toBe(99999);
});
it("attemptAbandoned: fresh is fresh, old is abandoned, and a saved session is never abandoned", () => {
  expect(attemptAbandoned({expires_at:reservedAgo(60_000),stripe_session_id:null})).toBe(false);
  expect(attemptAbandoned({expires_at:reservedAgo(ABANDONED_ATTEMPT_MS),stripe_session_id:null})).toBe(true);
  expect(attemptAbandoned({expires_at:reservedAgo(ABANDONED_ATTEMPT_MS * 10),stripe_session_id:"cs_1"})).toBe(false);
  expect(attemptAbandoned({expires_at:null,stripe_session_id:null})).toBe(true);
});

// Back from Stripe with the browser's Back button, then Yearly or the other
// plan: refused for up to an hour with "try again in a moment".
it("closes an open checkout for another price and opens the one asked for", async () => {
  rpc.mockResolvedValueOnce({data:[{id:"attempt-one",parameters,stripe_session_id:"cs_one"}]})
    .mockResolvedValueOnce({data:[{id:"attempt-two",expires_at:reservedAgo(0),parameters:{...parameters,line_items:[{price:"price_2",quantity:1}]}}]});
  retrieve.mockResolvedValue({id:"cs_one",client_reference_id:"account",status:"open"});
  create.mockResolvedValue({id:"cs_two",url:"https://checkout.stripe.com/two",status:"open"});
  const session = await createPendingCheckout("account",{...parameters,line_items:[{price:"price_2",quantity:1}]});
  expect(expire).toHaveBeenCalledWith("cs_one");
  expect(deletes[0]).toContainEqual(["eq","id","attempt-one"]);
  expect(create.mock.calls[0][0].line_items).toEqual([{price:"price_2",quantity:1}]);
  expect(session.id).toBe("cs_two");
});
it("hands back the same open checkout when the same price is chosen again", async () => {
  rpc.mockResolvedValue({data:[{id:"attempt-one",parameters,stripe_session_id:"cs_one"}]});
  retrieve.mockResolvedValue({id:"cs_one",client_reference_id:"account",status:"open"});
  await createPendingCheckout("account",parameters);
  expect(expire).not.toHaveBeenCalled();
  expect(create.mock.calls[0][1]).toEqual({idempotencyKey:"checkout:attempt-one"});
});
