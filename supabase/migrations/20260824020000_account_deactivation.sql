-- ParkOS: self-service account deactivation.
--
-- Deactivation is account-level (one auth user), not org-level, so it cannot
-- live on `profiles` (staff only) or `customers` (one row PER org). This is the
-- first table keyed on the auth user itself. A row exists only once an account
-- has been deactivated; `status` still carries the value so a future
-- reactivation is an UPDATE rather than a DELETE.
--
-- Nothing here erases data. Reservations, payments, and receipts are untouched
-- by design (ARCHITECTURE.md §5, §6); full deletion is a manual, out-of-band
-- request.

create table public.account_status (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  status         text not null check (status in ('active', 'deactivated')),
  deactivated_at timestamptz,
  created_at     timestamptz not null default now()
);

comment on table public.account_status is
  'Account-level lifecycle for an auth user. Written only by deactivate_account().';

-- Read-only to the browser: a user may see their own status so the login flow
-- can explain the rejection. No insert/update/delete policy exists, so the only
-- writer is the SECURITY DEFINER function below.
grant select on public.account_status to authenticated;

alter table public.account_status enable row level security;
create policy account_status_select_self on public.account_status
  for select to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Lockout: one check, wired into the three helpers every RLS policy calls
-- ---------------------------------------------------------------------------
-- Revoking the session is not enough on its own — a JWT already in a browser
-- stays cryptographically valid until it expires. Rather than repeat a guard in
-- every policy, the check goes into get_user_role / has_any_role /
-- is_own_customer, which are the only paths RLS is allowed to authorize
-- through (see the rule at the top of the Week 2 schema).
create or replace function public.is_account_deactivated()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.account_status a
     where a.user_id = auth.uid()
       and a.status = 'deactivated'
  );
$$;

revoke all on function public.is_account_deactivated() from public;
grant execute on function public.is_account_deactivated() to authenticated;

create or replace function public.get_user_role(check_org_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.role::text
  from public.memberships m
  where m.org_id = check_org_id
    and m.user_id = auth.uid()
    and not public.is_account_deactivated()
  limit 1
$$;

create or replace function public.has_any_role(check_org_id uuid, allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.org_id = check_org_id
      and m.user_id = auth.uid()
      and m.role::text = any(allowed_roles)
      and not public.is_account_deactivated()
  )
$$;

create or replace function public.is_own_customer(check_customer_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
      from public.customers c
     where c.id = check_customer_id
       and c.user_id = auth.uid()
  ) and not public.is_account_deactivated();
$$;

-- ---------------------------------------------------------------------------
-- deactivate_account: the whole flow in one transaction
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER because it must write account_status (no client write policy
-- exists) and delete the caller's auth sessions, neither of which an
-- authenticated browser role may do. It trusts nothing but auth.uid().
create or replace function public.deactivate_account()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
  end if;

  -- Billing outlives the account otherwise. Anything not yet cancelled still
  -- has a live Stripe subscription behind it — a `suspended` permit is a failed
  -- payment, not a closed one — so the block is deliberately wider than
  -- status = 'active'. The permit's Stripe subscription id is not required
  -- here: a freshly issued permit is active before the webhook writes it back.
  if exists (
    select 1
      from public.permits p
      join public.customers c on c.id = p.customer_id
     where c.user_id = v_user_id
       and p.archived_at is null
       and p.status <> 'cancelled'
  ) then
    raise exception using errcode = 'P0001', message = 'PERMIT_SUBSCRIPTION_ACTIVE';
  end if;

  insert into public.account_status (user_id, status, deactivated_at)
  values (v_user_id, 'deactivated', now())
  on conflict (user_id) do update
     set status = 'deactivated',
         deactivated_at = now();

  -- Revoke every active session. Refresh tokens are deleted explicitly rather
  -- than relying on GoTrue's cascade, so a schema change there cannot silently
  -- leave a usable token behind.
  delete from auth.refresh_tokens
   where session_id in (select s.id from auth.sessions s where s.user_id = v_user_id);
  delete from auth.sessions
   where user_id = v_user_id;

  -- Reservations, payments, and receipts are intentionally NOT touched.
end;
$$;

revoke all on function public.deactivate_account() from public;
grant execute on function public.deactivate_account() to authenticated;
