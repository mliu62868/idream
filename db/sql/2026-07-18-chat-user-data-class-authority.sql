-- Extend the cross-service user authority with provenance classification.
-- RUN AS: core_owner. Appending the column preserves existing view consumers.

CREATE OR REPLACE VIEW core.chat_user_view AS
SELECT
  u.id                       AS user_id,
  u."displayName"            AS display_name,
  COALESCE(p.locale, 'en')   AS locale,
  u.status                   AS status,
  u."deletedAt"              AS deleted_at,
  u."updatedAt"              AS updated_at,
  u."dataClass"              AS data_class
FROM public.users u
LEFT JOIN public.user_preferences p ON p."userId" = u.id;

GRANT SELECT ON core.chat_user_view TO chat_service;
