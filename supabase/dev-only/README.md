# Development-only database scripts

These files contain fake ParkOS development data and assertions that depend on
that data. They deliberately live outside `supabase/migrations/` so a production
`supabase db push` cannot apply them.

Run these scripts only against a disposable local Supabase database. Every entry
point requires `PARKOS_TEST_DATABASE_URL`, validates that its hostname is
loopback, and passes the URL explicitly to the CLI. The runner never uses a
linked project.

```sh
$env:PARKOS_TEST_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
npm run db:seed:dev
npm run test:db
npm run test:financial
```

Never run the seed against production. The seed is intended for a fresh dev
database; it is not safe to re-run after its generated spaces already exist.
`supabase/seed.sql` is intentionally empty so a normal reset cannot load these
fixtures without the explicit loopback-guarded command.
