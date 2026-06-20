-- P0-1 boundary · grants (design §2). The teeth of the boundary.
-- RUN order: core_owner grants on views; chat_owner grants on chat.* tables.

-- ---- core_owner: expose the 4 read-only views to chat_service -----------------
-- (run as core_owner)
GRANT SELECT ON core.chat_user_view              TO chat_service;
GRANT SELECT ON core.chat_character_view         TO chat_service;
GRANT SELECT ON core.chat_character_tags_view    TO chat_service;
GRANT SELECT ON billing.chat_entitlement_view    TO chat_service;
GRANT SELECT ON compliance.chat_user_eligibility_view TO chat_service;

-- ---- chat_owner: chat runtime read/write on chat.* ---------------------------
-- (run as chat_owner)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA chat TO chat_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA chat
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO chat_service;
-- cuids are app-generated, but grant sequence usage in case future tables use serial.
GRANT USAGE ON ALL SEQUENCES IN SCHEMA chat TO chat_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA chat GRANT USAGE ON SEQUENCES TO chat_service;

-- ---- explicit deny posture (belt-and-suspenders) -----------------------------
-- chat_service is NOT granted anything on public.* base tables, so it cannot read
-- or write users/characters/entitlements directly. Revoke any inherited PUBLIC
-- grants on the sensitive base tables to be safe.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM chat_service;
REVOKE USAGE ON SCHEMA public FROM chat_service;
