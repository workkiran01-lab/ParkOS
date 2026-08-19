-- Removes the throwaway table from the workflow test.
-- Both migration files stay in the repo as a record of the round trip.
drop table public._migration_test;
