-- One durable Checkout attempt per account. A retry, second tab or lost
-- response reuses the same Stripe idempotency key and exact parameters.
create table if not exists public.billing_checkout_attempts (
  account_id uuid primary key references public.accounts(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  parameters jsonb not null,
  expires_at timestamptz not null,
  stripe_session_id text
);
alter table public.billing_checkout_attempts enable row level security;
revoke all on public.billing_checkout_attempts from anon, authenticated;
grant all on public.billing_checkout_attempts to service_role;

create or replace function public.claim_checkout_attempt(p_account_id uuid, p_parameters jsonb, p_expires_at timestamptz)
returns setof public.billing_checkout_attempts
language plpgsql security invoker set search_path = public as $$
begin
  insert into public.billing_checkout_attempts(account_id, parameters, expires_at)
  values(p_account_id, p_parameters, p_expires_at)
  on conflict(account_id) do nothing;
  return query select * from public.billing_checkout_attempts where account_id = p_account_id;
end;
$$;
revoke all on function public.claim_checkout_attempt(uuid,jsonb,timestamptz) from public, anon, authenticated;
grant execute on function public.claim_checkout_attempt(uuid,jsonb,timestamptz) to service_role;
