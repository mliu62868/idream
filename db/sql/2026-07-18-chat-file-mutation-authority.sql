\set ON_ERROR_STOP on

-- The canonical chat authority DDL owns the upgrade-safe ledger definition.
-- Reuse it here so fresh installs, partial-table upgrades, and later boundary
-- replays cannot drift into different trigger/grant semantics.
\ir 03_chat_tables.sql
