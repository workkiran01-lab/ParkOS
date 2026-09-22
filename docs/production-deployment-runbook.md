# Production deployment runbook — report only

Prepared 2026-09-22. No command in this document was run against parkos-dev or parkos-prod, and no Edge Function was deployed during the audit. The stated empty Free-tier production project, zero secrets/functions/migrations, and absence of backups are operator-provided facts, not observations from this session.

This is a future operator procedure. Keep customer intake disabled until every acceptance check below succeeds.

## 1. Establish the release and recovery boundary

Use one main commit whose actual merge SHA passed all three CI jobs. Record its SHA, lockfiles, 56 migration filenames/checksums, function source, frontend configuration, and the intended production project identity in the release record. Reconfirm production is empty before using an empty-install procedure. Do not copy a development database or its environment file.

There is no automatic reverse-migration plan. Before admitting real data, arrange an independent database export, private Storage-object backup, configuration inventory, and a tested restore procedure to a separate environment. Git contains application definitions, not recoverable customer data. If the reported absence of backups is still true, this remains a production-readiness gap. After payments start, respond to incidents by stopping new intake, preserving Stripe events and database evidence, and applying reviewed forward fixes; do not reset production to recover.

## 2. Prepare production secrets and origins

Keep deployment credentials separate from application secrets. Supabase access tokens and a database password are operator credentials; they do not belong in the frontend or repository. Do not print secret values in logs.

| Variable                                                      | Required use and production value                                                                                                                                          |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`                                                | Edge runtime's production project URL; platform-provided.                                                                                                                  |
| `SUPABASE_ANON_KEY` or fallback `SUPABASE_PUBLISHABLE_KEY`    | Production public API key for authenticated client construction. The code checks the former first.                                                                         |
| `SUPABASE_SERVICE_ROLE_KEY` or fallback `SUPABASE_SECRET_KEY` | Production elevated server credential. The code checks the former first. Never expose it as a Vite variable.                                                               |
| `STRIPE_SECRET_KEY`                                           | Production Stripe account's live secret key for live payments; test keys only in a separate test environment. Webhook construction also requires this configuration.       |
| `STRIPE_WEBHOOK_SECRET`                                       | Signing secret for this exact production Stripe event destination and mode. A CLI forwarding secret or a different destination's secret will reject legitimate deliveries. |
| `RESEND_API_KEY`                                              | Sending-enabled key for the verified production sender/domain. Missing key skips email instead of failing payment processing.                                              |
| `RECEIPT_FROM_EMAIL`                                          | An address on a domain verified with Resend, such as `ParkOS <receipts@your-domain.example>`; replace the example.                                                         |
| `PUBLIC_APP_URL`                                              | Public production frontend origin for receipt QR links. Omission produces a bare booking-code QR rather than a navigation URL.                                             |
| `VITE_SUPABASE_URL`                                           | Frontend build-time production project URL. Rebuild after changing it.                                                                                                     |
| `VITE_SUPABASE_ANON_KEY`                                      | Frontend build-time production public/publishable key; the variable name is retained by the current client.                                                                |

Supabase supplies standard runtime variables; verify availability rather than copying development values. See [Supabase environment variables](https://supabase.com/docs/guides/functions/secrets). Current source does not use a Stripe publishable-key variable: reservation checkout and permit invoices use Stripe-hosted collection.

Change the sender before testing delivery to customers. Resend's default `onboarding@resend.dev` sender is restricted to testing with the account owner's address. A 403 becomes a logged skipped-email result in this application, while the payment still succeeds. Verify delivery to a separate real mailbox after authorization; a stored receipt row or HTTP 200 is insufficient evidence. [Resend sender restriction](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain)

Configure production Auth site/redirect URLs and frontend origins independently. A main push automatically triggers the repository's Vercel Production integration; a successful frontend deployment does not apply Supabase migrations or deploy Edge Functions. The Vercel backend configuration was not inspected in this session.

## 3. Deploy Edge Functions before migrations

Deploy the approved function source first, while intake and event delivery are controlled. Then apply migrations. This ordering prevents an old dispatcher from claiming newly relevant invoice events before ignoring their type. A current handler calling a missing new RPC instead returns an error, leaving Stripe's delivery eligible for retry.

Correction to the original premise: the repository's pre-merge main already routed both `invoice.paid` and `invoice.payment_succeeded`; the actual hosted function version and Stripe destination subscriptions were not inspected. The dangerous old-dispatcher scenario is an upgrade risk, not a confirmed description of deployed production. On an actually empty project there is no old deployed dispatcher; functions-first still makes the rollout failure mode explicit.

Future command shape, shown only as a reference:

```text
supabase functions deploy stripe-webhook --project-ref <verified-production-ref> --no-verify-jwt
supabase functions deploy create-checkout-session --project-ref <verified-production-ref>
supabase functions deploy create-permit-subscription --project-ref <verified-production-ref>
supabase functions deploy refund-payment --project-ref <verified-production-ref>
supabase functions deploy receipt-download --project-ref <verified-production-ref>
```

The webhook must disable Supabase's JWT check because Stripe supplies its signature rather than a Supabase user token. Keep signature verification in the handler. Keep the other endpoints' caller authentication. The current repository has no `[functions.stripe-webhook]` override, so the deploy flag matters. See [Supabase function configuration](https://supabase.com/docs/guides/functions/function-configuration) and the [official Stripe webhook deployment example](https://github.com/supabase/supabase/blob/master/examples/edge-functions/supabase/functions/stripe-webhooks/README.md).

Use the exact production webhook URL and live-mode endpoint secret. Configure these handled event types:

- `invoice.paid`, `invoice.payment_succeeded`, `invoice.payment_failed`
- `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
- `checkout.session.completed`, `checkout.session.async_payment_failed`, `checkout.session.expired`
- `payment_intent.payment_failed`, `charge.failed`, `charge.refunded`

The API request version is pinned in source to `2026-08-26.dahlia` with stripe-node 22.6.0. The event destination's API version is a separate setting and must be checked explicitly. Test the exact event payload version before enabling live intake. Basil removed legacy invoice payment fields and moved invoice/payment linkage into Invoice Payments; current source reads modern invoice status, parent subscription details, item billing periods, and confirmation secrets. [Stripe API change](https://docs.stripe.com/changelog/basil/2025-03-31/add-support-for-multiple-partial-payments-on-invoices)

For a signed event, accept 200 ignored only for unrelated/duplicate work; malformed supported payloads remain 400, configuration failures 503, and genuine database/identifier failures 500. Acknowledged ignored events are not automatically repaired by later state changes. Retain event IDs for explicit reconciliation. Stripe retries failed deliveries and can deliver duplicates or out of order; verify ledger and event-claim state when replaying. [Stripe webhook behavior](https://docs.stripe.com/webhooks)

## 4. Apply immutable migrations without development fixtures

Inspect the migration plan first. Dry-run new SQL against a disposable production-like database inside `BEGIN` / `ROLLBACK`, then perform the separately authorized production apply. Apply the complete ordered chain, ending at `20260922000000_ignore_unrelated_permit_events.sql`. The nav branch and the follow-up audit added no migrations. Do not edit historical migrations.

Only `supabase/migrations` belongs in the production migration stream. `supabase/seed.sql` is intentionally empty. Development identities and fake organizations live in `supabase/dev-only/DEV_ONLY_seed_dev_orgs.sql`, outside that stream. The normal seed/verifier scripts reject non-loopback database URLs. Never run that dev-only SQL manually against production or copy the disposable CI database. These repository controls prevent automatic seed inclusion; they cannot prevent an operator bypassing them.

After apply, inspect migration history and check for development UUIDs/domains before onboarding the real organization. Validate private receipt Storage bucket/policies, Auth configuration, RLS and API permissions, and client configuration. Create real production accounts through the application.

## 5. Verify cron positively

The older no-show scheduling block catches failures and emits a NOTICE, so migration completion does not prove that job exists. The later permit reconciliation migration does fail if its schedule cannot be created. Both jobs still need inspection:

```sql
select jobname, schedule, command, active
from cron.job
where jobname in ('parkos-no-show-sweep', 'parkos-permit-reconciliation');
```

Require exactly two active rows: no-show sweep every five minutes, permit reconciliation every fifteen minutes. Inspect the commands, owner/database and `cron.job_run_details` after scheduled execution. Reconciliation only detects and logs stuck permits; it does not call Stripe or repair them.

In a disposable rehearsal, create positive fixtures and execute the registered commands: the no-show case must mark one reservation, release its hold and write an audit; reconciliation must report known stuck permits without changing them. An empty report or a `select 1` cron command is not proof. CI's verifier and four cron mutations exercise these cases. Production monitoring must alert on missing jobs, failures and unresolved reconciliation warnings.

## 6. Compare actual privileges before admitting traffic

The Windows native harness uses explicit grants and a BYPASSRLS service role. Supabase container CI may supply broader defaults; the new `Report local privilege model` CI step prints its actual role flags, default ACLs, and service-role table grants. Do not equate either environment with the uninspected production catalog.

Record production `pg_default_acl`, role flags, table/sequence/function privileges, RLS coverage and policies, including defaults for every role that creates objects. The TRUNCATE migration revokes existing application-table privileges and the executing owner's defaults; it does not establish defaults for every possible future object owner.

Required acceptance checks:

- Browser roles cannot TRUNCATE application tables or execute service-only payment processors.
- Public/anonymous function execution is restricted to the declared public interface.
- Every exposed application table has the expected RLS policies; cross-tenant writes and reads fail.
- Last active admin and deactivation guards remain effective.
- The service client can perform the actual receipt join and numbered insert, payment writes, permit/customer updates and refund-link persistence.
- Receipt-number sequence access is tested through `nextval`; either USAGE or UPDATE can authorize it. A mutation must revoke both to prove denial.

Ignoring the divergence has two failure modes: broad defaults hide missing explicit grants until a stricter install breaks checkout/receipts, while broad browser grants expose data or destructive operations when RLS is missing or bypassed. RLS does not constrain a BYPASSRLS service role and does not protect TRUNCATE. Never ship an elevated key in the frontend. No production privilege equivalence is certified by this audit.

## 7. Run controlled acceptance and reconcile delivery

After separate authorization, exercise a real reservation payment and a monthly permit through the production setup, with clearly identified controlled accounts. Verify each durable fact: one payment ledger entry, one processed event claim, correct permit/reservation state and hold, audit records, downloadable PDF, and delivered receipt email. Replay both invoice event types and confirm invoice/event deduplication. Exercise the documented refund paths and verify the resulting ledger instead of trusting the response alone.

Confirm every staff/customer route against the actual production backend, including tenant isolation. Local runtime tests use synthetic login plus PostgREST and do not certify real Supabase Auth, Realtime, Stripe, Storage or Resend delivery.

Known unresolved limits remain: receipt issuance claims its row before upload/email and has no durable retry queue; webhook replay does not guarantee repairing a missing PDF/email. Permit refund storage remains a single-payment/full-refund model; multi-PaymentIntent and partial/out-of-band settlement need explicit reconciliation. Do not report these paths as end-to-end verified. Preserve failed event/receipt identifiers and resolve them through a reviewed recovery procedure before launch acceptance.
