# Development-only database scripts

These files contain fake ParkOS development data and assertions that depend on
that data. They deliberately live outside `supabase/migrations/` so a production
`supabase db push` cannot apply them.

Run a script manually only against the linked `parkos-dev` project. Every verifier
has an npm script; none of them run in CI yet.

```sh
npm run test:db                     # booth payments
npm run test:acl                    # no anon execute
npm run verify:booth-revenue
npm run verify:daily-manifest
npm run verify:permit-payments
npm run verify:permit-event-ordering
npm run verify:permit-revenue
npm run verify:invoice-paid
npm run verify:dead-branch
npm run verify:permit-cancellation
npm run verify:permit-issuance
npm run verify:rls
```

The seed has no script on purpose -- see the warning below:

```sh
npx supabase db query --linked --file supabase/dev-only/DEV_ONLY_seed_dev_orgs.sql
```

Never run the seed against production. The seed is intended for a fresh dev
database; it is not safe to re-run after its generated spaces already exist.
