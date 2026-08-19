-- ParkOS Week 4: organization signup, authentication onboarding, and staff invites.
-- Follows the shared-schema tenancy, UUID, UTC timestamptz, and helper-based RLS
-- conventions established by ARCHITECTURE.md and the Week 2 schema.

-- ---------------------------------------------------------------------------
-- Staff invitations
-- ---------------------------------------------------------------------------

create table public.invites (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id),
  email       text not null,
  role        public.app_role not null,
  token       uuid not null default gen_random_uuid() unique,
  invited_by  uuid not null references auth.users(id),
  accepted_at timestamptz,
  expires_at  timestamptz not null default (now() + interval '7 days'),
  created_at  timestamptz not null default now(),
  check (length(trim(email)) > 0),
  check (expires_at > created_at)
);

create unique index invites_org_id_email_pending_key
  on public.invites (org_id, email)
  where accepted_at is null;
create index on public.invites (org_id);

grant select, insert, update, delete on public.invites to authenticated;

alter table public.invites enable row level security;
create policy invites_select on public.invites
  for select using (public.has_any_role(org_id, array['admin']));
create policy invites_insert on public.invites
  for insert with check (public.has_any_role(org_id, array['admin']));
create policy invites_update on public.invites
  for update using (public.has_any_role(org_id, array['admin']))
             with check (public.has_any_role(org_id, array['admin']));
create policy invites_delete on public.invites
  for delete using (public.has_any_role(org_id, array['admin']));

-- ---------------------------------------------------------------------------
-- Atomic organization creation
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER is required here because a brand-new user has no membership,
-- so ordinary RLS cannot authorize the organization/profile/membership bootstrap.
-- Instead, this function trusts only auth.uid(), verifies that user has no profile
-- (the one-organization-per-user rule), and creates all three rows atomically.
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

-- ---------------------------------------------------------------------------
-- Atomic invite acceptance
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER is required because the invitee is not an org member yet and
-- therefore cannot read the admin-only invite or insert their first profile and
-- membership through normal RLS. The function locks the token row, checks its
-- state, compares its email with auth.uid()'s actual auth.users email, enforces
-- one organization per user, and only then performs the atomic acceptance.
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

  if lower(trim(v_user_email)) <> lower(trim(v_invite_email)) then
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

revoke all on function public.create_organization_with_admin(text) from public;
revoke all on function public.accept_invite(uuid) from public;
grant execute on function public.create_organization_with_admin(text) to authenticated;
grant execute on function public.accept_invite(uuid) to authenticated;
