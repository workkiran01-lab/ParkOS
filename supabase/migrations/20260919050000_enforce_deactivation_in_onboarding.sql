-- Definer onboarding RPCs bypass table RLS, so each must enforce account lockout.
create or replace function public.create_organization_with_admin(p_org_name text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_full_name text;
begin
  if v_user_id is null then
    raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
  end if;
  if public.is_account_deactivated() then
    raise exception using errcode = 'P0001', message = 'ACCOUNT_DEACTIVATED';
  end if;

  if p_org_name is null or length(trim(p_org_name)) = 0 then
    raise exception using errcode = 'P0001', message = 'ORGANIZATION_NAME_REQUIRED';
  end if;

  if exists (select 1 from public.profiles p where p.id = v_user_id) then
    raise exception using errcode = 'P0001', message = 'USER_ALREADY_HAS_ORGANIZATION';
  end if;

  select coalesce(
           nullif(trim(u.raw_user_meta_data ->> 'full_name'), ''),
           split_part(u.email, '@', 1)
         )
    into v_full_name
    from auth.users u
   where u.id = v_user_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'AUTH_USER_NOT_FOUND';
  end if;

  insert into public.organizations (name)
  values (trim(p_org_name))
  returning id into v_org_id;

  insert into public.profiles (id, org_id, full_name)
  values (v_user_id, v_org_id, v_full_name);

  insert into public.memberships (org_id, user_id, role)
  values (v_org_id, v_user_id, 'admin');

  return v_org_id;
end;
$$;

create or replace function public.public_ensure_customer(
  p_facility_id uuid,
  p_full_name text default null,
  p_email text default null,
  p_phone text default null
)
returns table (customer_id uuid, org_id uuid, full_name text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_customer public.customers%rowtype;
begin
  if v_user_id is null then
    raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
  end if;
  if public.is_account_deactivated() then
    raise exception using errcode = 'P0001', message = 'ACCOUNT_DEACTIVATED';
  end if;

  select f.org_id into v_org_id
    from public.facilities f
   where f.id = p_facility_id
     and f.archived_at is null;

  if not found then
    raise exception using errcode = 'P0002', message = 'FACILITY_NOT_FOUND';
  end if;

  select * into v_customer
    from public.customers c
   where c.org_id = v_org_id
     and c.user_id = v_user_id;

  if found then
    return query select v_customer.id, v_customer.org_id, v_customer.full_name;
    return;
  end if;

  if p_full_name is null or length(trim(p_full_name)) = 0 then
    raise exception using errcode = 'P0001', message = 'CUSTOMER_DETAILS_REQUIRED';
  end if;

  insert into public.customers (org_id, user_id, full_name, email, phone)
  values (
    v_org_id,
    v_user_id,
    trim(p_full_name),
    nullif(trim(coalesce(p_email, '')), ''),
    nullif(trim(coalesce(p_phone, '')), '')
  )
  on conflict (org_id, user_id) where user_id is not null do nothing;

  -- Re-read instead of RETURNING: a concurrent insert may have won the race.
  select * into v_customer
    from public.customers c
   where c.org_id = v_org_id
     and c.user_id = v_user_id;

  return query select v_customer.id, v_customer.org_id, v_customer.full_name;
end;
$$;

create or replace function public.accept_invite(p_token uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_invite_id uuid;
  v_org_id uuid;
  v_invite_email text;
  v_invite_role public.app_role;
  v_accepted_at timestamptz;
  v_expires_at timestamptz;
  v_user_email text;
  v_full_name text;
begin
  if v_user_id is null then
    raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
  end if;
  if public.is_account_deactivated() then
    raise exception using errcode = 'P0001', message = 'ACCOUNT_DEACTIVATED';
  end if;

  select i.id, i.org_id, i.email, i.role, i.accepted_at, i.expires_at
    into v_invite_id, v_org_id, v_invite_email, v_invite_role,
         v_accepted_at, v_expires_at
    from public.invites i
   where i.token = p_token
   for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'INVITE_NOT_FOUND';
  end if;

  if v_accepted_at is not null then
    raise exception using errcode = 'P0001', message = 'INVITE_ALREADY_ACCEPTED';
  end if;

  if v_expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'INVITE_EXPIRED';
  end if;

  select u.email,
         coalesce(
           nullif(trim(u.raw_user_meta_data ->> 'full_name'), ''),
           split_part(u.email, '@', 1)
         )
    into v_user_email, v_full_name
    from auth.users u
   where u.id = v_user_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'AUTH_USER_NOT_FOUND';
  end if;

  if lower(trim(v_user_email)) is distinct from lower(trim(v_invite_email)) then
    raise exception using errcode = 'P0001', message = 'INVITE_EMAIL_MISMATCH';
  end if;

  if exists (select 1 from public.profiles p where p.id = v_user_id) then
    raise exception using errcode = 'P0001', message = 'USER_ALREADY_HAS_ORGANIZATION';
  end if;

  insert into public.profiles (id, org_id, full_name)
  values (v_user_id, v_org_id, v_full_name);

  insert into public.memberships (org_id, user_id, role)
  values (v_org_id, v_user_id, v_invite_role);

  update public.invites
     set accepted_at = now()
   where id = v_invite_id;

  return v_org_id;
end;
$$;
