import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assertLoopbackDatabaseUrl } from './local-database.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const url = assertLoopbackDatabaseUrl(process.env.PARKOS_TEST_DATABASE_URL)
const invoiceVerifier =
  'supabase/dev-only/20260903000000_verify_invoice_paid.sql'
const cases = [
  ...[
    'create_organization_with_admin',
    'public_ensure_customer',
    'accept_invite',
  ].map((fn) => ({
    name: `Deactivated onboarding rejects bypass in ${fn}`,
    function: fn,
    pattern:
      /  if public\.is_account_deactivated\(\) then\n    raise exception using errcode = 'P0001', message = 'ACCOUNT_DEACTIVATED';\n  end if;/,
    replacement: '',
    verifier: 'supabase/dev-only/DEV_ONLY_verify_rls_isolation.sql',
    witness: 'CHECK15 FAIL: deactivated identity executed',
  })),
  {
    name: 'Invitations reject SQL NULL email bypass',
    function: 'accept_invite',
    pattern:
      /lower\(trim\(v_user_email\)\) is distinct from lower\(trim\(v_invite_email\)\)/,
    replacement: 'lower(trim(v_user_email)) <> lower(trim(v_invite_email))',
    verifier: 'supabase/dev-only/DEV_ONLY_verify_rls_isolation.sql',
    witness:
      'CHECK14 FAIL: missing or mismatched email accepted an admin invitation',
  },
  ...[false, true].map((defaults) => ({
    name: `Client TRUNCATE rejects ${defaults ? 'unsafe future defaults' : 'unsafe existing grants'}`,
    scriptPattern: 'begin;',
    scriptReplacement:
      'begin;\n' +
      (defaults
        ? 'alter default privileges in schema public grant truncate on tables to authenticated;'
        : 'grant truncate on public.memberships to authenticated;'),
    verifier: 'supabase/dev-only/DEV_ONLY_verify_rls_isolation.sql',
    witness: defaults
      ? 'CHECK0d FAIL: newly created tables inherit client TRUNCATE'
      : 'CHECK0d FAIL: client TRUNCATE bypasses tenant isolation',
  })),
  {
    name: 'Walk-in rejects forged GUC authorization',
    function: 'enforce_reservation_operating_hours',
    pattern: /\nbegin\n/,
    replacement: `\nbegin\n  if current_setting('parkos.walk_in_checkin', true) = 'on' then return new; end if;\n`,
    verifier: 'supabase/dev-only/20260907020000_verify_facility_time.sql',
    witness: 'WALKIN FAIL: forged GUC bypassed scheduled operating hours',
  },
  {
    name: 'Walk-in retains closed-hours exemption',
    function: 'enforce_reservation_operating_hours',
    pattern: /if found then return new; end if;/,
    replacement: 'if found then null; end if;',
    verifier: 'supabase/dev-only/20260907020000_verify_facility_time.sql',
    witness: 'OUTSIDE_OPERATING_HOURS',
  },
  {
    name: 'Walk-in rejects client authorization-table grants',
    scriptPattern: 'begin;',
    scriptReplacement:
      'begin;\ngrant insert on public.walk_in_authorizations to authenticated;',
    verifier: 'supabase/dev-only/20260907020000_verify_facility_time.sql',
    witness: 'WALKIN FAIL: authorization table grants client privileges',
  },
  {
    name: 'Walk-in rejects foreign tenant authorization',
    function: 'check_in_walk_in',
    pattern:
      /if not public\.has_any_role\(v_org_id, array\['admin','manager','attendant'\]\) then/,
    replacement: 'if false then',
    verifier: 'supabase/dev-only/20260907020000_verify_facility_time.sql',
    witness: 'WALKIN FAIL: foreign admin checked in a walk-in',
  },
  ...[false, true].map((changeOwner) => ({
    name: `Privileged catalog catches throwaway definer${changeOwner ? ' under another owner' : ''}`,
    scriptPattern: 'begin;',
    scriptReplacement: `begin;
      create function public.verifier_uncovered_definer() returns integer
      language sql security definer set search_path = '' as 'select 1';
      revoke all on function public.verifier_uncovered_definer() from public, anon, authenticated, service_role;
      ${changeOwner ? 'alter function public.verifier_uncovered_definer() owner to service_role;' : ''}`,
    verifier: 'supabase/dev-only/DEV_ONLY_verify_privileged_functions.sql',
    witness:
      'SECURITY DEFINER function has no verifier coverage: verifier_uncovered_definer',
  })),
  {
    name: 'Privileged catalog catches stale coverage from the same declaration',
    scriptPattern: 'as coverage(proname, exposure, scope, verifier);',
    scriptReplacement: `as coverage(proname, exposure, scope, verifier);
      insert into verifier_privileged_coverage values ('verifier_stale_name', 'internal', 'internal', 'missing.sql');`,
    verifier: 'supabase/dev-only/DEV_ONLY_verify_privileged_functions.sql',
    witness:
      'SECURITY DEFINER coverage names no deployed function: verifier_stale_name',
  },
  {
    name: 'Last admin rejects removed membership safeguard',
    scriptPattern: 'begin;',
    scriptReplacement:
      'begin;\nalter table public.memberships disable trigger memberships_preserve_last_admin;',
    verifier: 'supabase/dev-only/DEV_ONLY_verify_rls_isolation.sql',
    witness: 'CHECK13 FAIL: last admin membership removal/demotion succeeded',
  },
  {
    name: 'Last admin rejects removed deactivation safeguard',
    scriptPattern: 'begin;',
    scriptReplacement:
      'begin;\nalter table public.account_status disable trigger account_status_preserve_last_admin;',
    verifier: 'supabase/dev-only/DEV_ONLY_verify_rls_isolation.sql',
    witness:
      'CHECK13 FAIL: reassignment/deletion/deactivation removed the last active admin',
  },
  {
    name: 'Checkout rejects removed overstay pricing',
    function: 'calculate_overstay',
    pattern: /\nbegin\n/,
    replacement: `\nbegin\n  if p_reservation_id = 'ff000000-0000-0000-0000-00000000e004' then
    return query select 0, '{}'::jsonb; return;
  end if;\n`,
    verifier: 'supabase/dev-only/20260825010000_verify_booth_payments.sql',
    witness: 'CHECK9 FAIL: overstay = 0c',
  },
  ...['parkos-permit-reconciliation', 'parkos-no-show-sweep'].map((job) => ({
    name: `Cron rejects a no-op command: ${job}`,
    scriptPattern: 'begin;',
    scriptReplacement: `begin;\nselect cron.schedule(jobname, schedule, 'select 1') from cron.job where jobname = '${job}';`,
    verifier:
      'supabase/dev-only/20260901000000_verify_permit_event_ordering_guard.sql',
    witness:
      job === 'parkos-no-show-sweep'
        ? 'CRON FAIL: no-show command is'
        : 'CRON FAIL: reconciliation command is',
  })),
  ...[
    ['log_permit_reconciliation', 'CRON FAIL: reconciliation command found'],
    ['mark_no_shows', 'CRON FAIL: no-show command did not mark'],
  ].map(([fn, witness]) => ({
    name: `Cron rejects removed job behavior: ${fn}`,
    function: fn,
    pattern: /\nbegin\n/,
    replacement: '\nbegin\n  return 0;\n',
    verifier:
      'supabase/dev-only/20260901000000_verify_permit_event_ordering_guard.sql',
    witness,
  })),
  {
    name: 'Partial permit refund silently returns no result',
    function: 'record_permit_refund',
    pattern: /\nbegin\n/,
    replacement: `\nbegin\n  if p_amount_refunded_cents = 5000 then return null; end if;\n`,
    verifier: 'supabase/dev-only/20260906000000_verify_refund_ledgers.sql',
    witness: 'CHECK2 FAIL: a partial refund returned',
  },
  {
    name: 'Cancelled permit payment claims success without recording money',
    function: 'record_permit_payment',
    pattern: /  insert into public\.processed_stripe_events/,
    replacement: `  if v_permit.status = 'cancelled' then
      return jsonb_build_object('processed', true, 'outcome', 'permit_payment_recorded');
    end if;
  insert into public.processed_stripe_events`,
    verifier: 'supabase/dev-only/20260829000000_verify_permit_payments.sql',
    witness: 'CHECK8 FAIL: cancelled-permit payment is missing from the ledger',
  },
  {
    name: 'Correction result omits affected identifiers',
    function: 'correct_reservation',
    pattern:
      /select v_reservation\.booking_code, v_total, v_quote, v_affected;/,
    replacement: `select v_reservation.booking_code, v_total, v_quote, '[{}]'::jsonb;`,
    verifier:
      'supabase/dev-only/20260907010000_verify_reservation_corrections.sql',
    witness:
      'CORRECTION FAIL: correct_reservation did not return the affected reservation',
  },
  {
    name: 'Correction preview omits affected identifiers',
    function: 'reservation_correction_scope',
    pattern: /    v_affected;\nend;/,
    replacement: `    '[{}]'::jsonb;\nend;`,
    verifier:
      'supabase/dev-only/20260907010000_verify_reservation_corrections.sql',
    witness:
      'CORRECTION FAIL: correction scope preview did not match the affected set',
  },
  {
    name: 'Correction preview omits its count',
    function: 'reservation_correction_scope',
    pattern: /pg_catalog\.jsonb_array_length\(v_affected\)/,
    replacement: 'null::integer',
    verifier:
      'supabase/dev-only/20260907010000_verify_reservation_corrections.sql',
    witness:
      'CORRECTION FAIL: correction scope preview did not match the affected set',
  },
  ...[
    [
      'refund',
      '20260906000000_verify_refund_ledgers.sql',
      '-- CHECK 4 -- THE TRAP',
      'CHECK4',
    ],
    [
      'state',
      '20260904000000_verify_dead_branch_removed.sql',
      '-- CHECK 1 -- every cell',
      'CHECK1',
    ],
  ].flatMap(([label, file, anchor, check]) =>
    [
      'delete from actual;',
      'delete from actual where ctid = (select ctid from actual limit 1);',
      'insert into actual select * from actual limit 1;',
    ].map((sql, index) => ({
      name: `${label} matrix rejects ${['empty', 'missing', 'duplicate'][index]} observations`,
      scriptPattern: anchor,
      scriptReplacement: sql + '\n' + anchor,
      verifier: 'supabase/dev-only/' + file,
      witness: `${check} FAIL:`,
    })),
  ),
  ...[
    ['daily boundaries', '2028-02-15 14:00:00+00', 'exact daily boundaries'],
    ['before opening', '2028-02-15 13:59:00+00', 'before-opening window'],
    ['after closing', '2028-02-16 05:00:00+00', 'after-closing window'],
    [
      'overnight boundaries',
      '2028-02-16 06:00:00+00',
      'overnight exact boundaries',
    ],
    [
      'before overnight opening',
      '2028-02-16 05:59:00+00',
      'pre-overnight-opening window',
    ],
    ['weekly open', '2028-02-14 17:00:00+00', 'weekly open day'],
    ['weekly closed', '2028-02-15 18:00:00+00', 'weekly closed day'],
    ['weekly full day', '2028-02-16 08:00:00+00', 'weekly 24-hour day'],
    [
      'multiple days with closure',
      '2028-02-15 00:00:00+00',
      'multi-day window crossed',
    ],
    [
      'multiple days across DST',
      '2026-03-07 00:00:00+00',
      'multi-day 24-hour DST window',
    ],
  ].map(([label, instant, witness]) => ({
    name: `Facility time rejects null: ${label}`,
    function: 'facility_accepts_reservation_window',
    pattern: /\nbegin\n/,
    replacement: `\nbegin\n  if p_start = timestamptz '${instant}' then return null; end if;\n`,
    verifier: 'supabase/dev-only/20260907020000_verify_facility_time.sql',
    witness: `TIME FAIL: ${witness}`,
  })),
  ...[
    ['2026-01-15 10:30', 'normal conversion'],
    ['2026-11-01 01:30', 'fall-back overlap'],
  ].map(([local, witness]) => ({
    name: `Facility time rejects null: ${witness}`,
    function: 'facility_local_to_utc',
    pattern: /\nbegin\n/,
    replacement: `\nbegin\n  if p_local = timestamp '${local}' then return null; end if;\n`,
    verifier: 'supabase/dev-only/20260907020000_verify_facility_time.sql',
    witness: `TIME FAIL: ${witness}`,
  })),
  {
    name: 'Facility time rejects null: IANA validation',
    function: 'is_valid_iana_timezone',
    pattern: /select exists \(/,
    replacement:
      "select case when p_timezone = 'UTC' then null else true end and exists (",
    verifier: 'supabase/dev-only/20260907020000_verify_facility_time.sql',
    witness:
      'TIME FAIL: IANA timezone validation disagrees with policy for UTC',
  },
  ...['CHECK1', 'CHECK2', 'CHECK3', 'CHECK4'].map((check) => ({
    name: `Overstay ${check} rejects empty pricing`,
    function: 'calculate_overstay',
    emptyFunction: true,
    isolateCheck: check,
    verifier: 'supabase/dev-only/20260825010000_verify_booth_payments.sql',
    witness: `${check} FAIL:`,
  })),
  {
    name: 'Manifest leaks another tenant through definer privileges',
    function: 'facility_daily_manifest',
    pattern: /LANGUAGE sql/,
    replacement: 'LANGUAGE sql SECURITY DEFINER',
    verifier: 'supabase/dev-only/20260826010000_verify_daily_manifest.sql',
    witness: '8. cross-tenant facility returns zero rows: FAIL',
  },
  {
    name: 'Manifest counts refunded booth money',
    function: 'facility_daily_manifest',
    pattern: /and bp\.status = 'succeeded'/,
    replacement: '',
    verifier: 'supabase/dev-only/20260826010000_verify_daily_manifest.sql',
    witness: '2. paid_cents == raw booth+succeeded payments: FAIL',
  },
  {
    name: 'Manifest duplicates otherwise correct rows',
    function: 'facility_daily_manifest',
    pattern: /from target t/,
    replacement:
      "from target t cross join generate_series(1, case when t.facility_id = '11111111-1111-1111-1111-111111111111' then 2 else 1 end) duplicate_rows",
    verifier: 'supabase/dev-only/20260826010000_verify_daily_manifest.sql',
    witness: '4. row set matches hand-written predicate: FAIL',
  },
  ...[
    ['facility_dashboard_summary', 'CHECK2'],
    ['report_revenue_by_period', 'CHECK3'],
    ['report_revenue_by_space_type', 'CHECK4'],
    ['report_revenue_split', 'CHECK4'],
    ['facility_dashboard_summary', 'CHECK5'],
  ].map(([fn, check]) => ({
    name: `Booth revenue ${check} rejects empty ${fn}`,
    function: fn,
    emptyFunction: true,
    isolateCheck: check,
    verifier:
      'supabase/dev-only/20260826000000_verify_booth_revenue_reporting.sql',
    witness: `${check} FAIL:`,
  })),
  {
    name: 'Manifest defaults to UTC today',
    function: 'facility_daily_manifest',
    pattern: /now\(\) at time zone public\.safe_timezone\(f\.timezone\)/,
    replacement: "now() at time zone 'UTC'",
    verifier: 'supabase/dev-only/20260826010000_verify_daily_manifest.sql',
    witness: '9. default p_date uses local today across UTC midnight: FAIL',
  },
  {
    name: 'Default manifest silently returns no rows',
    function: 'facility_daily_manifest',
    pattern: /where f\.id = p_facility_id/,
    replacement: 'where f.id = p_facility_id and p_date is not null',
    verifier: 'supabase/dev-only/20260826010000_verify_daily_manifest.sql',
    witness: '9. default p_date uses local today across UTC midnight: FAIL',
  },
  {
    name: 'Default manifest includes an extra day',
    function: 'facility_daily_manifest',
    pattern: /and \(\s*\(lower\(r\.during\)/,
    replacement: 'and (p_date is null or (lower(r.during)',
    verifier: 'supabase/dev-only/20260826010000_verify_daily_manifest.sql',
    witness: '9. default p_date uses local today across UTC midnight: FAIL',
  },
  {
    name: 'Subscription processor accepts a misrouted invoice',
    function: 'process_stripe_subscription_event',
    pattern:
      /  if p_event_type is null or p_event_type not in \([\s\S]*?message = 'STRIPE_EVENT_TYPE_UNSUPPORTED';\n  end if;/,
    replacement: '',
    verifier: invoiceVerifier,
    witness: 'ROUTING FAIL: subscription processor accepted invoice.paid',
  },
  {
    name: 'Reservation processor accepts a misrouted invoice',
    function: 'process_stripe_event',
    pattern:
      /  if p_event_type is null or p_event_type not in \([\s\S]*?message = 'STRIPE_EVENT_TYPE_UNSUPPORTED';\n  end if;/,
    replacement: '',
    verifier: invoiceVerifier,
    witness: 'PAYMENT_IDENTIFIER_REQUIRED',
  },
  {
    name: 'Permit recorder loses event-ID deduplication',
    function: 'record_permit_payment',
    pattern: /\nbegin\n/,
    replacement:
      '\nbegin\n  p_event_id := p_event_id || gen_random_uuid()::text;\n',
    verifier: invoiceVerifier,
    witness: 'DEDUP FAIL: replay returned',
  },
]

function psql(sql, scalar = false) {
  const result = spawnSync(
    'psql',
    ['--no-psqlrc', '--set=ON_ERROR_STOP=1', ...(scalar ? ['-At'] : []), url],
    {
      cwd: root,
      input: sql,
      encoding: 'utf8',
    },
  )
  assert.ifError(result.error)
  return {
    status: result.status,
    output: result.stdout + result.stderr,
    stdout: result.stdout,
  }
}

const selected = cases.filter(
  (mutation) => !process.argv[2] || mutation.name.includes(process.argv[2]),
)
assert.ok(selected.length, 'No matching SQL mutations')
for (const mutation of selected) {
  let changed = ''
  if (mutation.function) {
    const definition = psql(
      `select pg_get_functiondef(oid) from pg_proc where pronamespace = 'public'::regnamespace and proname = '${mutation.function}';`,
      true,
    )
    assert.equal(definition.status, 0, definition.output)
    const original = definition.stdout.replaceAll('\r', '')
    if (mutation.emptyFunction) {
      assert.match(original, /LANGUAGE (sql|plpgsql)/)
      changed = original
        .replace('LANGUAGE sql', 'LANGUAGE plpgsql')
        .replace(
          /AS \$function\$[\s\S]*?\$function\$/,
          () => 'AS $function$ BEGIN RETURN; END; $function$',
        )
    } else {
      assert.match(
        original,
        mutation.pattern,
        `${mutation.name}: missing mutation anchor`,
      )
      changed = original.replace(mutation.pattern, mutation.replacement)
    }
  }
  let verifier = readFileSync(
    new URL('../' + mutation.verifier, import.meta.url),
    'utf8',
  )
  if (mutation.isolateCheck) {
    // Keep the real fixture and selected assertion block. Independent checks
    // must each fail, rather than hiding behind an earlier check's failure.
    verifier = verifier.replace(/do \$\$[\s\S]*?end \$\$;/g, (block) =>
      block.includes(`${mutation.isolateCheck} FAIL:`) ? block : '',
    )
  }
  assert.match(verifier, /\bbegin;/i)
  assert.match(verifier, /\brollback;/i)
  // Mutation and fixtures share one transaction. Even an assertion failure
  // rolls back the replacement function when psql disconnects.
  let brokenVerifier = verifier
  if (mutation.scriptPattern) {
    assert.ok(
      verifier.includes(mutation.scriptPattern),
      'Missing script mutation anchor',
    )
    brokenVerifier = verifier.replace(
      mutation.scriptPattern,
      mutation.scriptReplacement,
    )
  }
  const broken = psql(
    brokenVerifier.replace(/\bbegin;/i, () => 'begin;\n' + changed + ';\n'),
  )
  console.log(`MUTATION: ${mutation.name}\n${broken.output}`)
  assert.notEqual(broken.status, 0, `${mutation.name}: mutant survived`)
  assert.ok(
    broken.output.includes(mutation.witness),
    `${mutation.name}: wrong failure`,
  )
  const restored = psql(verifier)
  console.log(`RESTORED: ${mutation.name}\n${restored.output}`)
  assert.equal(restored.status, 0, `${mutation.name}: restored verifier failed`)
}
