# Postgres for console state

The console keeps its own state (Alerts, Reports, Reviews, Sessions, Connections, Action Log) in
Postgres through Drizzle, even though it runs on one machine. SQLite would be simpler to start, but
the console is meant to become a shared team server, and moving stores later means migrating every
row and every query that leans on Postgres types such as `jsonb` and `timestamptz`.

## Considered Options

- **SQLite with Drizzle**: no container to run, but a second migration path once the console is
  shared.
