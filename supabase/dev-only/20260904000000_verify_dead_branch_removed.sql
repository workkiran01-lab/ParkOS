-- DEV-ONLY verification that dropping the 'invoice.paid' arm from
-- process_stripe_subscription_event changed nothing any caller can reach.
--
--   npx supabase db query --linked --file supabase/dev-only/20260904000000_verify_dead_branch_removed.sql
--
-- Assertion-only: every check RAISES on failure. One transaction, ends in
-- ROLLBACK, so no fixture survives.
--
-- HOW THIS IS TESTED. The arm was unreachable through the webhook, so a test
-- that only drives the webhook's real routes could never observe it at all --
-- it would pass whether or not the arm existed, which proves nothing. Instead
-- this calls the function DIRECTLY with p_event_type = 'invoice.paid', which no
-- production caller does, and pins the result. Every REACHABLE event type is
-- driven through the same matrix so that a regression in the shared branch --
-- the real risk in editing that IN list -- fails here.
--
-- An invoice payload carries no subscription status, so the webhook passes
-- p_stripe_status = NULL for invoice events; subscription events carry a real
-- status. The matrix supplies each accordingly.
--
-- Expected values below were captured from the function BEFORE the arm was
-- removed and re-checked after, so rows 5-16 are a genuine before/after
-- comparison rather than a restatement of the new code. Before removal, row 1
-- read 'pending -> suspended' with the subscription id and period written; that
-- is the ONLY behaviour this migration changes, and nothing can reach it.
--
-- Depends on the dev seed (DEV_ONLY_seed_dev_orgs.sql) for Org A:
--   Org A (Harbor Park Group) = aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa

begin;

create temporary table expected (
  seq integer, event_type text, start_status text,
  end_status text, outcome text, writes_columns boolean
) on commit drop;

-- writes_columns: whether the arm taken is one that UPDATEs permits, observed
-- as "the billing period got written". The removed arm did; the else arm the
-- invoice.paid rows now fall into does not.
insert into expected values
  ( 1, 'invoice.paid',                  'pending',   'pending',   'permit_pending',   false),
  ( 2, 'invoice.paid',                  'suspended', 'suspended', 'permit_suspended', false),
  ( 3, 'invoice.paid',                  'active',    'active',    'permit_active',    false),
  ( 4, 'invoice.paid',                  'cancelled', 'cancelled', 'permit_cancelled', false),
  ( 5, 'customer.subscription.created', 'pending',   'active',    'permit_active',    true),
  ( 6, 'customer.subscription.created', 'suspended', 'active',    'permit_active',    true),
  ( 7, 'customer.subscription.created', 'active',    'active',    'permit_active',    true),
  ( 8, 'customer.subscription.created', 'cancelled', 'cancelled', 'permit_cancelled', true),
  ( 9, 'customer.subscription.updated', 'pending',   'active',    'permit_active',    true),
  (10, 'customer.subscription.updated', 'suspended', 'active',    'permit_active',    true),
  (11, 'customer.subscription.updated', 'active',    'active',    'permit_active',    true),
  (12, 'customer.subscription.updated', 'cancelled', 'cancelled', 'permit_cancelled', true),
  (13, 'invoice.payment_failed',        'pending',   'suspended', 'permit_suspended', false),
  (14, 'invoice.payment_failed',        'suspended', 'suspended', 'permit_suspended', false),
  (15, 'invoice.payment_failed',        'active',    'suspended', 'permit_suspended', false),
  (16, 'invoice.payment_failed',        'cancelled', 'cancelled', 'permit_cancelled', false);

create temporary table actual (
  seq integer, event_type text, start_status text,
  end_status text, outcome text, writes_columns boolean, sub_after text
) on commit drop;

insert into public.facilities (id, org_id, name, timezone)
values ('ab000000-0000-0000-0000-0000000000f1',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Dead Branch Lot', 'America/Los_Angeles');
insert into public.zones (id, org_id, facility_id, name)
values ('ab000000-0000-0000-0000-0000000000f2',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'ab000000-0000-0000-0000-0000000000f1', 'Dead Branch Zone');
insert into public.customers (id, org_id, full_name, user_id)
values ('ab000000-0000-0000-0000-0000000000f4',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Dead Branch Driver', null);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  v_event text; v_start text; v_status text; v_permit uuid; v_space uuid;
  v_result jsonb; v_sub text; v_pend timestamptz; v_supplied text;
  n integer := 0;
begin
  foreach v_event in array array[
    'invoice.paid',
    'customer.subscription.created',
    'customer.subscription.updated',
    'invoice.payment_failed'
  ] loop
    foreach v_start in array array['pending', 'suspended', 'active', 'cancelled'] loop
      n := n + 1;
      v_space  := ('ab000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid;
      v_permit := ('ab000000-0000-0000-1111-' || lpad(n::text, 12, '0'))::uuid;

      insert into public.spaces (id, org_id, zone_id, space_number)
      values (v_space, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
              'ab000000-0000-0000-0000-0000000000f2', 'DB' || n);

      -- A pending permit holds no subscription id yet, which is what makes the
      -- removed arm's write to that column visible when it fired.
      insert into public.permits
        (id, org_id, facility_id, space_id, customer_id, during,
         monthly_rate_cents, currency, status, stripe_subscription_id,
         current_period_start, current_period_end)
      values (v_permit, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
              'ab000000-0000-0000-0000-0000000000f1', v_space,
              'ab000000-0000-0000-0000-0000000000f4',
              tstzrange(now() - interval '1 month', null, '[)'),
              15000, 'USD', v_start,
              case when v_start = 'pending' then null else 'sub_dead_' || n end,
              null, null);

      v_supplied := case when v_event like 'invoice.%' then null else 'active' end;

      v_result := public.process_stripe_subscription_event(
        'evt_dead_' || n, v_event, v_permit, 'sub_dead_' || n,
        v_supplied,
        now() - interval '1 day', now() + interval '29 days', null);

      select status, stripe_subscription_id, current_period_end
        into v_status, v_sub, v_pend
        from public.permits where id = v_permit;

      insert into actual
      values (n, v_event, v_start, v_status, v_result ->> 'outcome',
              v_pend is not null, coalesce(v_sub, 'NULL'));
    end loop;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- CHECK 1 -- every cell matches, expected-vs-actual.
-- ---------------------------------------------------------------------------
do $$
declare r record; v int := 0;
begin
  for r in
    select e.seq, e.event_type, e.start_status,
           e.end_status as exp_status, a.end_status as got_status,
           e.outcome as exp_outcome, a.outcome as got_outcome,
           e.writes_columns as exp_writes, a.writes_columns as got_writes
      from expected e join actual a using (seq)
     where e.end_status is distinct from a.end_status
        or e.outcome is distinct from a.outcome
        or e.writes_columns is distinct from a.writes_columns
  loop
    v := v + 1;
    raise warning 'ROW % (% from %): status %/% outcome %/% writes %/%',
      r.seq, r.event_type, r.start_status, r.exp_status, r.got_status,
      r.exp_outcome, r.got_outcome, r.exp_writes, r.got_writes;
  end loop;
  if v > 0 then
    raise exception 'CHECK1 FAIL: % of 16 matrix cells differ from expected', v;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- CHECK 2 -- invoice.paid is now completely inert: it writes NOTHING. The
-- pending permit is the witness, because it starts with a NULL subscription id
-- and the removed arm used to fill it in.
-- ---------------------------------------------------------------------------
do $$
declare v_sub text; v_writes boolean;
begin
  select sub_after, writes_columns into v_sub, v_writes
    from actual where event_type = 'invoice.paid' and start_status = 'pending';
  if v_sub <> 'NULL' then
    raise exception 'CHECK2 FAIL: invoice.paid wrote stripe_subscription_id = %, expected no write', v_sub;
  end if;
  if v_writes then
    raise exception 'CHECK2 FAIL: invoice.paid wrote the billing period, expected no write';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- CHECK 3 -- the arm is really gone from the deployed function body, not just
-- unexercised by this matrix.
-- ---------------------------------------------------------------------------
do $$
declare v_src text;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'process_stripe_subscription_event';
  if v_src is null then
    raise exception 'CHECK3 FAIL: process_stripe_subscription_event not found';
  end if;
  if position('invoice.paid' in v_src) > 0 then
    raise exception 'CHECK3 FAIL: the deployed function still contains invoice.paid';
  end if;
  -- ...and the siblings that SHARE that arm must still be in it.
  if position('customer.subscription.created' in v_src) = 0
     or position('customer.subscription.updated' in v_src) = 0 then
    raise exception 'CHECK3 FAIL: removing invoice.paid also removed a sibling event type';
  end if;
end $$;

reset role;

select
  a.seq,
  a.event_type,
  a.start_status || ' -> ' || a.end_status as transition,
  a.outcome,
  a.writes_columns as wrote_permit_row,
  a.sub_after as subscription_id_after,
  case when e.end_status = a.end_status and e.outcome = a.outcome
            and e.writes_columns = a.writes_columns
       then 'MATCH' else 'MISMATCH' end as verdict
from actual a join expected e using (seq)
order by a.seq;

rollback;
