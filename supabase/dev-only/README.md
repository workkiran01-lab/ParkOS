# Development-only database scripts

These files contain fake ParkOS development data and assertions that depend on
that data. They deliberately live outside `supabase/migrations/` so a production
`supabase db push` cannot apply them.

Run a script manually only against the linked `parkos-dev` project. The installed
Supabase CLI exposes file execution as `db query`:

```sh
npx supabase db query --linked --file supabase/dev-only/DEV_ONLY_seed_dev_orgs.sql
npx supabase db query --linked --file supabase/dev-only/DEV_ONLY_verify_rls_isolation.sql
npx supabase db query --linked --file supabase/dev-only/DEV_ONLY_verify_permit_cancellation.sql
```

Never run the seed against production. The seed is intended for a fresh dev
database; it is not safe to re-run after its generated spaces already exist.
