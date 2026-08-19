-- Throwaway table proving the migration workflow end to end.
-- Dropped again in the following migration; both files stay as a record.
create table public._migration_test (
  id bigint generated always as identity primary key
);
