-- A phone-only auth user must not bypass an email-bound invitation through SQL NULL comparison.
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
