# ParkOS

Parking management SaaS. Vite + React 19 + TypeScript, Tailwind CSS v4, TanStack Router (file-based), Supabase.

> [!IMPORTANT]
> ## Database schema rule
> **Schema changes only happen via migration files in `supabase/migrations/`, committed to git.**
> Never edit the schema through the Supabase dashboard UI — the dashboard is for reading and debugging only.
>
> Workflow:
> ```sh
> npx supabase migration new <name>   # creates supabase/migrations/<timestamp>_<name>.sql
> # write the SQL, then:
> npx supabase db push                # applies pending migrations to the linked project
> ```

## Environments

One Supabase org (`ParkOS`) with two projects:

| Project     | URL                                        | Use                     |
| ----------- | ------------------------------------------ | ----------------------- |
| parkos-dev  | https://adxaihmccvewwnkunnkm.supabase.co   | development (linked)    |
| parkos-prod | https://kzsjentyojrdhpzdnrfr.supabase.co   | production (not linked) |

## Setup

```sh
npm install
cp .env.example .env.local   # then fill in the parkos-dev URL and publishable key
npm run dev
```

Secrets: `.env.local` is gitignored and holds only the publishable (anon) key. The secret (service-role) key and DB passwords must never appear in this repo.

## Scripts

- `npm run dev` — Vite dev server
- `npm run build` — type-check + production build
- `npm run lint` — ESLint
- `npm run format` — Prettier
