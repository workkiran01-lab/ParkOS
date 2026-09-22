-- Preserve an organization's last usable administrator across membership
-- deletion, demotion, reassignment, auth-user deletion and account deactivation.
-- No removal UI or new public RPC is introduced.
create function public.preserve_last_active_admin()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_orgs uuid[];
  v_org uuid;
begin
  if tg_table_name = 'memberships' then
    if old.role <> 'admin' then return null; end if;
    v_orgs := array[old.org_id];
  else
    if new.status <> 'deactivated' then return null; end if;
    select array_agg(m.org_id order by m.org_id) into v_orgs
      from public.memberships m
     where m.user_id = new.user_id and m.role = 'admin';
  end if;

  foreach v_org in array coalesce(v_orgs, array[]::uuid[]) loop
    -- A real row version, not just an advisory/row lock: at REPEATABLE READ
    -- a concurrent change must raise serialization_failure instead of letting
    -- an old snapshot count an administrator who has already been removed.
    -- At READ COMMITTED the following statement gets a fresh snapshot.
    update public.organizations set name = name where id = v_org;
    if not found then continue; end if;

    if not exists (
      select 1 from public.memberships m
      where m.org_id = v_org and m.role = 'admin'
        and not exists (
          select 1 from public.account_status a
          where a.user_id = m.user_id and a.status = 'deactivated'
        )
    ) then
      raise exception using errcode = '23514', message = 'LAST_ACTIVE_ADMIN_REQUIRED';
    end if;
  end loop;
  return null;
end;
$$;

revoke all on function public.preserve_last_active_admin()
  from public, anon, authenticated, service_role;

create trigger memberships_preserve_last_admin
after delete or update of org_id, user_id, role on public.memberships
for each row execute function public.preserve_last_active_admin();

create trigger account_status_preserve_last_admin
after insert or update of user_id, status on public.account_status
for each row execute function public.preserve_last_active_admin();
