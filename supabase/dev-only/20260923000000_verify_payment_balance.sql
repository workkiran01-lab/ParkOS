-- Independent cent oracles: expected values below are literals computed from
-- the fixture rows and event amounts, never from either balance implementation.
-- A: 1000 pending => 0 collectable; terminal failure => 1000 collectable.
-- B: 1000 paid - 200 refunded = 800 retained => 200 collectable, not 1000.
-- C: 500 - 100 + 200 cash + 300 pending = 900 committed => 100 collectable.
-- D: historical partial refund with unknown amount => collection blocked.
-- E: 1000 pending => 1000 settled; collectable remains 0 throughout.
begin;
insert into public.reservations(id,org_id,facility_id,space_id,customer_id,during,status,price_breakdown,total_cents)
select ('ba000000-0000-0000-0000-00000000000' || n)::uuid,
       'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
       '11111111-1111-1111-1111-111111111111',
       (select s.id from public.spaces s join public.zones z on z.id=s.zone_id
         where z.facility_id='11111111-1111-1111-1111-111111111111' limit 1),
       'ca000001-0000-0000-0000-000000000001',
       '[2036-02-10 18:00Z,2036-02-10 20:00Z)', 'active','{}',1000
  from generate_series(1,6) n;

create function pg_temp.expect_balance(n integer, paid integer, pending integer, due integer)
returns void language plpgsql as $$
declare id uuid := ('ba000000-0000-0000-0000-00000000000' || n)::uuid;
        actual integer; manifest record; totals record;
begin
  select public.reservation_balance_cents(id) into actual;
  if actual is distinct from due then
    raise exception 'BALANCE FAIL case %: expected %, got %',n,due,actual;
  end if;
  select * into strict manifest from public.facility_daily_manifest(
    '11111111-1111-1111-1111-111111111111','2036-02-10') where reservation_id=id;
  if manifest.paid_cents is distinct from paid or manifest.balance_cents is distinct from due then
    raise exception 'MANIFEST BALANCE FAIL case %: expected paid % due %, got paid % due %',
      n,paid,due,manifest.paid_cents,manifest.balance_cents;
  end if;
  select * into strict totals from public.reservation_payment_totals(id);
  if totals.pending_cents is distinct from pending then
    raise exception 'PENDING FAIL case %: expected %, got %',n,pending,totals.pending_cents;
  end if;
end $$;
create function pg_temp.refuse_collection(n integer, amount integer)
returns void language plpgsql as $$
declare before_rows bigint; after_rows bigint; msg text;
begin
  select count(*) into before_rows from public.booth_payments;
  begin
    perform public.record_booth_payment(('ba000000-0000-0000-0000-00000000000'||n)::uuid,amount,'cash');
    raise exception 'COLLECTION FAIL: overcollection accepted, case %, amount %',n,amount;
  exception when others then
    get stacked diagnostics msg=message_text;
    if msg <> 'AMOUNT_EXCEEDS_BALANCE' then raise; end if;
  end;
  select count(*) into after_rows from public.booth_payments;
  if after_rows is distinct from before_rows then raise exception 'COLLECTION FAIL: refusal wrote money'; end if;
end $$;

insert into public.payments(id,org_id,reservation_id,stripe_checkout_session_id,amount_cents,status,refunded_cents)
values
('ba000000-0000-0000-0000-000000000011','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','ba000000-0000-0000-0000-000000000001','cs_balance_a',1000,'pending',0),
('ba000000-0000-0000-0000-000000000012','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','ba000000-0000-0000-0000-000000000002','cs_balance_b',1000,'succeeded',0),
('ba000000-0000-0000-0000-000000000013','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','ba000000-0000-0000-0000-000000000003','cs_balance_c1',500,'partially_refunded',100),
('ba000000-0000-0000-0000-000000000014','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','ba000000-0000-0000-0000-000000000003','cs_balance_c2',300,'pending',0),
('ba000000-0000-0000-0000-000000000015','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','ba000000-0000-0000-0000-000000000004','cs_balance_d',1000,'partially_refunded',null),
('ba000000-0000-0000-0000-000000000016','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','ba000000-0000-0000-0000-000000000005','parkos_pending:ba000000-0000-0000-0000-000000000016',1000,'pending',0),
('ba000000-0000-0000-0000-000000000017','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','ba000000-0000-0000-0000-000000000006','cs_balance_f1',1000,'partially_refunded',200),
('ba000000-0000-0000-0000-000000000018','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','ba000000-0000-0000-0000-000000000006','cs_balance_f2',200,'pending',0);
insert into public.booth_payments(org_id,reservation_id,amount_cents,method,collected_by)
values('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','ba000000-0000-0000-0000-000000000003',200,'cash','00000000-0000-0000-0000-0000000000a1');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
select pg_temp.expect_balance(1,0,1000,0);
select pg_temp.refuse_collection(1,1000);
select pg_temp.refuse_collection(1,1);
select pg_temp.expect_balance(2,1000,0,0);
select pg_temp.expect_balance(3,600,300,100);
select pg_temp.refuse_collection(3,101);
select * from public.record_booth_payment('ba000000-0000-0000-0000-000000000003',100,'cash');
select pg_temp.expect_balance(3,700,300,0);
select pg_temp.expect_balance(4,0,0,0);
select pg_temp.refuse_collection(4,1);
select pg_temp.expect_balance(5,0,1000,0);
select pg_temp.expect_balance(6,800,200,0);
select pg_temp.refuse_collection(6,1);

reset role;
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$ declare msg text; begin
  begin
    insert into public.payments(org_id,reservation_id,stripe_checkout_session_id,amount_cents,status)
    values('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','ba000000-0000-0000-0000-000000000001','cs_second_claim',1,'pending');
    raise exception 'ONLINE CLAIM FAIL: second claim overcommitted booking';
  exception when others then get stacked diagnostics msg=message_text;
    if msg <> 'AMOUNT_EXCEEDS_BALANCE' then raise; end if;
  end;
end $$;
select public.process_stripe_event('balance_decline','payment_intent.payment_failed','ba000000-0000-0000-0000-000000000011',null,null,null,1000,'USD');
reset role;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
select pg_temp.expect_balance(1,0,1000,0); -- a retryable decline does not close Checkout
select pg_temp.refuse_collection(1,1);

reset role;
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select public.process_stripe_event('balance_failed','checkout.session.async_payment_failed','ba000000-0000-0000-0000-000000000011',null,null,null,1000,'USD');
select public.process_stripe_event('balance_refund_200','charge.refunded','ba000000-0000-0000-0000-000000000012',null,null,null,1000,'USD',200);
select public.process_stripe_event('balance_expired','checkout.session.expired','ba000000-0000-0000-0000-000000000014',null,null,null,300,'USD');
select public.process_stripe_event('balance_legacy_repaired','charge.refunded','ba000000-0000-0000-0000-000000000015',null,null,null,1000,'USD',300);
select public.process_stripe_event('balance_completed','checkout.session.completed','ba000000-0000-0000-0000-000000000016',null,'cs_balance_e',null,1000,'USD');
select public.process_stripe_event('balance_remainder_completed','checkout.session.completed','ba000000-0000-0000-0000-000000000018',null,'cs_balance_f2',null,200,'USD');
do $$ begin
  if (select stripe_checkout_session_id from public.payments where id='ba000000-0000-0000-0000-000000000016') is distinct from 'cs_balance_e' then
    raise exception 'CHECKOUT CLAIM FAIL: early webhook did not attach session';
  end if;
end $$;
reset role;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
select pg_temp.expect_balance(1,0,0,1000);
select pg_temp.expect_balance(2,800,0,200);
select pg_temp.refuse_collection(2,1000);
select pg_temp.refuse_collection(2,201);
select pg_temp.expect_balance(3,700,0,300);
select pg_temp.expect_balance(4,700,0,300);
select pg_temp.expect_balance(5,1000,0,0);
select pg_temp.expect_balance(6,1000,0,0);
select pg_temp.refuse_collection(5,1);
select * from public.record_booth_payment('ba000000-0000-0000-0000-000000000001',1000,'cash');
select * from public.record_booth_payment('ba000000-0000-0000-0000-000000000002',200,'cash');
select * from public.record_booth_payment('ba000000-0000-0000-0000-000000000003',300,'cash');
select * from public.record_booth_payment('ba000000-0000-0000-0000-000000000004',300,'cash');
select pg_temp.expect_balance(1,1000,0,0);
select pg_temp.expect_balance(2,1000,0,0);
select pg_temp.expect_balance(3,1000,0,0);
select pg_temp.expect_balance(4,1000,0,0);

reset role;
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select public.process_stripe_event('balance_older_refund','charge.refunded','ba000000-0000-0000-0000-000000000012',null,null,null,1000,'USD',100);
do $$ begin
  if (select refunded_cents from public.payments where id='ba000000-0000-0000-0000-000000000012') is distinct from 200 then
    raise exception 'RAW MONEY FAIL: old event reduced the cumulative 200-cent refund';
  end if;
end $$;
select public.process_stripe_event('balance_duplicate_refund','charge.refunded','ba000000-0000-0000-0000-000000000012',null,null,null,1000,'USD',200);
reset role;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
select pg_temp.expect_balance(2,1000,0,0);
select pg_temp.refuse_collection(2,1);
do $$ declare raw_refund integer; raw_cash integer; begin
  select refunded_cents into strict raw_refund from public.payments where id='ba000000-0000-0000-0000-000000000012';
  select sum(amount_cents) into raw_cash from public.booth_payments where reservation_id='ba000000-0000-0000-0000-000000000002';
  if raw_refund is distinct from 200 or raw_cash is distinct from 200 then
    raise exception 'RAW MONEY FAIL: expected refund 200 and cash 200, got %/%',raw_refund,raw_cash;
  end if;
end $$;

reset role;
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select public.process_stripe_event('balance_full_refund','charge.refunded','ba000000-0000-0000-0000-000000000012',null,null,null,1000,'USD',1000);
reset role;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
select pg_temp.expect_balance(2,200,0,800); -- only the 200 cash remains
select pg_temp.refuse_collection(2,801);
select * from public.record_booth_payment('ba000000-0000-0000-0000-000000000002',800,'cash');
select pg_temp.expect_balance(2,1000,0,0);

-- The shared reader is INVOKER; an unrelated tenant receives no row.
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}',true);
do $$ begin
  if exists(select 1 from public.reservation_payment_totals('ba000000-0000-0000-0000-000000000001')) then
    raise exception 'ALLOCATION RLS FAIL: foreign balance exposed';
  end if;
end $$;
reset role;
do $$ begin raise notice 'PAYMENT BALANCE PASS: pending, failure, expiry, partial/full/old refunds, both readers, raw money, refusal and legitimate collection'; end $$;
rollback;
