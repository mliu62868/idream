#!/usr/bin/env bash
# Apply the P0-1 boundary SQL to a target DB with the correct executing roles,
# then prove the boundary has teeth (negative permission tests).
# Usage: CHAT_DATABASE_URL=... PGHOST=... PGPORT=... DB=... SUPER=... \
#   bash db/sql/apply-validate.sh
# Bash expands PS4 before the script's first command, so a traced invocation
# cannot safely consume credential-bearing environment variables. Refuse it;
# callers must also keep PS4 free of secrets because that first expansion occurs
# before this script can take control.
if [[ "$-" == *x* ]]; then
  set +x
  echo "FAIL: apply-validate.sh must not be invoked with shell xtrace" >&2
  exit 64
fi
set -euo pipefail
require_explicit_target() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "FAIL: $name must be set explicitly" >&2
    exit 64
  fi
}
require_explicit_target DB
require_explicit_target SUPER
require_explicit_target PGHOST
require_explicit_target PGPORT
require_explicit_target CHAT_DATABASE_URL

# psql -d accepts both a plain name and a full libpq connection string. The
# latter can override -h/-p/-U before the identity check and leak credentials.
case "$DB" in
  *"="*|postgres://*|postgresql://*)
    echo "FAIL: DB must be a plain PostgreSQL database name" >&2
    exit 64
    ;;
esac

# libpq treats comma-separated -h values as failover targets, while Node pg
# treats the same value as one hostname. This operator path requires one target.
case "$PGHOST" in
  *,*)
    echo "FAIL: PGHOST must name exactly one PostgreSQL host" >&2
    exit 64
    ;;
esac

# libpq otherwise accepts ambient target overrides in addition to the explicit
# -h/-p/-U/-d tuple below. Refuse ambiguity instead of silently clearing it.
for ambient_name in PGHOSTADDR PGSERVICE PGSERVICEFILE PGDATABASE PGUSER PGOPTIONS; do
  if [[ -n "${!ambient_name:-}" ]]; then
    echo "FAIL: ambient libpq target variable $ambient_name is not allowed" >&2
    exit 64
  fi
done

# The request-role URL is the runtime database authority. Refuse to apply DDL
# when the operator's explicit psql target differs, and never print credentials.
HERE="$(cd "$(dirname "$0")" && pwd)"
CHAT_PACKAGE_JSON="$(cd "$HERE/../../packages/chat" && pwd)/package.json"
TARGET_AUTHORITY="$(IDREAM_CHAT_PACKAGE_JSON="$CHAT_PACKAGE_JSON" command node -e '
try {
  const { createRequire } = require("node:module");
  const requireFromChat = createRequire(process.env.IDREAM_CHAT_PACKAGE_JSON);
  const { Client } = requireFromChat("pg");
  const raw = process.env.CHAT_DATABASE_URL;
  if (raw !== raw.trim()) throw new Error("outer-whitespace");
  const url = new URL(raw);
  const forbiddenOverrides = new Set([
    "database", "dbname", "host", "hostaddr", "passfile", "password",
    "port", "service", "user", "username",
  ]);
  for (const key of url.searchParams.keys()) {
    if (forbiddenOverrides.has(key.toLowerCase())) throw new Error("override");
  }
  if (url.pathname.startsWith("//")) throw new Error("multi-leading-slash");
  const protocol = url.protocol.toLowerCase();
  const declaredUser = decodeURIComponent(url.username);
  const expectedHost = process.env.PGHOST.toLowerCase();
  const expectedPort = process.env.PGPORT;
  // node-postgres falls back to ambient PG* values for URL components that are
  // absent. Parse the deployed URL itself; the explicit operator tuple is only
  // an independent value to compare against.
  for (const name of ["PGDATABASE", "PGHOST", "PGPORT", "PGUSER"]) {
    delete process.env[name];
  }
  const runtime = new Client({ connectionString: raw }).connectionParameters;
  const user = runtime.user;
  const host = String(runtime.host).toLowerCase();
  const port = String(runtime.port);
  const database = runtime.database;
  const matches =
    (protocol === "postgres:" || protocol === "postgresql:") &&
    declaredUser === "chat_service" &&
    user === "chat_service" &&
    host === expectedHost &&
    port === expectedPort &&
    database === process.env.DB;
  if (!matches) throw new Error("mismatch");
  process.stdout.write(`${user}@${host}:${port}/${database}`);
} catch {
  console.error("FAIL: CHAT_DATABASE_URL authority does not match explicit PGHOST/PGPORT/DB or chat_service role");
  process.exit(64);
}
')"
psql_super() {
  PGPASSWORD="${SUPER_PASSWORD:-${PGPASSWORD:-}}" command psql -X -h "$PGHOST" -p "$PGPORT" -v ON_ERROR_STOP=1 -q "$@"
}
psql_chat() {
  PGPASSWORD="${CHAT_SERVICE_PASSWORD:-${PGPASSWORD:-}}" command psql -X -h "$PGHOST" -p "$PGPORT" -v ON_ERROR_STOP=1 -q "$@"
}
psql_projector() {
  PGPASSWORD="${CHAT_PROJECTOR_PASSWORD:-${PGPASSWORD:-}}" command psql -X -h "$PGHOST" -p "$PGPORT" -v ON_ERROR_STOP=1 -q "$@"
}

# Bash 3.2 (the system shell on macOS) has no BASHPID. Build an isolated,
# shell-portable namespace before applying any SQL so the run cannot commit the
# boundary and then fail merely while naming its validation fixtures.
VALIDATION_PREFIX="val_$(date -u +%Y%m%d%H%M%S)_$$_${RANDOM}"
if [[ ! "$VALIDATION_PREFIX" =~ ^[a-z0-9_]+$ ]]; then
  echo "  FAIL: invalid validation fixture prefix"; exit 1
fi
report_failed_fixture_scope() {
  local status="$?"
  if [[ "$status" -ne 0 ]]; then
    echo "VALIDATION FAILED: inspect only fixture prefix '$VALIDATION_PREFIX'; a failed run may leave rows in that isolated namespace." >&2
  fi
  return "$status"
}
trap report_failed_fixture_scope EXIT

CONNECTED_IDENTITY="$(psql_super -U "$SUPER" -d "$DB" -tAF $'\t' -c "SELECT current_user,current_database();")"
EXPECTED_IDENTITY="${SUPER}"$'\t'"${DB}"
if [[ "$CONNECTED_IDENTITY" != "$EXPECTED_IDENTITY" ]]; then
  echo "FAIL: connected PostgreSQL identity does not match explicit SUPER/DB (expected ${SUPER}@${PGHOST}:${PGPORT}/${DB}; got ${CONNECTED_IDENTITY//$'\t'/@})" >&2
  exit 64
fi

# A role-specific REVOKE cannot override privileges inherited from PUBLIC.
# Rewriting PUBLIC here would alter Main/other database roles, so inherited
# CREATE or public table/column capabilities are an external DBA posture blocker and
# must fail before this script applies any boundary DDL.
PUBLIC_POSTURE_READY="$(psql_super -U "$SUPER" -d "$DB" -tAc "
  WITH inherited_schema_create AS (
    SELECT 1
    FROM pg_namespace AS namespace
    CROSS JOIN LATERAL aclexplode(
      COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))
    ) AS grant_entry
    WHERE namespace.nspname = 'public'
      AND grant_entry.grantee = 0
      AND grant_entry.privilege_type = 'CREATE'
  ), inherited_table_capability AS (
    SELECT 1
    FROM pg_class AS class
    JOIN pg_namespace AS namespace
      ON namespace.oid = class.relnamespace
    CROSS JOIN LATERAL aclexplode(
      COALESCE(class.relacl, acldefault('r', class.relowner))
    ) AS grant_entry
    WHERE namespace.nspname = 'public'
      AND class.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND grant_entry.grantee = 0
      AND grant_entry.privilege_type IN (
        'SELECT', 'INSERT', 'UPDATE', 'DELETE',
        'TRUNCATE', 'REFERENCES', 'TRIGGER'
      )
  ), inherited_column_capability AS (
    SELECT 1
    FROM pg_class AS class
    JOIN pg_namespace AS namespace
      ON namespace.oid = class.relnamespace
    JOIN pg_attribute AS attribute
      ON attribute.attrelid = class.oid
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    CROSS JOIN LATERAL aclexplode(attribute.attacl) AS grant_entry
    WHERE namespace.nspname = 'public'
      AND class.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND grant_entry.grantee = 0
      AND grant_entry.privilege_type IN (
        'SELECT', 'INSERT', 'UPDATE', 'REFERENCES'
      )
  )
  SELECT NOT EXISTS (SELECT 1 FROM inherited_schema_create)
    AND NOT EXISTS (SELECT 1 FROM inherited_table_capability)
    AND NOT EXISTS (SELECT 1 FROM inherited_column_capability);
" | tr -d '[:space:]')"
if [[ "$PUBLIC_POSTURE_READY" != "t" ]]; then
  echo "FAIL: public schema/table/column ACL exposes inherited runtime capability; repair the external database posture without broadening this Chat boundary" >&2
  exit 64
fi

echo "== applying boundary SQL to $TARGET_AUTHORITY =="
psql_super -U "$SUPER" -d "$DB" -f "$HERE/01_schemas_roles.sql"
psql_super -U "$SUPER" -d "$DB" -c "SET ROLE core_owner;" -f "$HERE/02_core_views.sql"
psql_super -U "$SUPER" -d "$DB" -c "SET ROLE chat_owner;" -f "$HERE/03_chat_tables.sql"
psql_super -U "$SUPER" -d "$DB" -f "$HERE/04_grants.sql"
echo "== applied =="

# Every invocation owns a fresh fixture namespace. Failed runs never collide
# with an earlier validation; the EXIT trap reports the exact cleanup scope.
SESSION_ID="${VALIDATION_PREFIX}_s1"
MESSAGE_ID="${VALIDATION_PREFIX}_m1"
RECEIPT_ID="${VALIDATION_PREFIX}_receipt1"
FILE_MUTATION_ID="${VALIDATION_PREFIX}_fm1"
PENDING_FILE_MUTATION_ID="${VALIDATION_PREFIX}_fm_pending"
FORGED_FILE_MUTATION_ID="${VALIDATION_PREFIX}_fm_forge"
SEQUENCE_FILE_MUTATION_ID="${VALIDATION_PREFIX}_fm_sequence"
RELATIONSHIP_MUTATION_ID="${VALIDATION_PREFIX}_fm_rel_reset"
ERASURE_MUTATION_ID="${VALIDATION_PREFIX}_fm_erase"
PROJECTOR_OUTBOX_ID="${VALIDATION_PREFIX}_projector_outbox"
USER_ID="${VALIDATION_PREFIX}_u1"
CHARACTER_ID="${VALIDATION_PREFIX}_c1"

must_be_true() {
  local label="$1"; local sql="$2"; local actual
  actual="$(psql_super -U "$SUPER" -d "$DB" -tAc "$sql" | tr -d '[:space:]')"
  if [[ "$actual" != "t" ]]; then
    echo "  FAIL: $label"; exit 1
  fi
  echo "  OK: $label"
}

must_be_true "memory authority trigger is exact and enabled" \
  "SELECT count(*) = 1 AND bool_and(tgenabled IN ('O', 'A') AND pg_get_triggerdef(oid) = 'CREATE TRIGGER message_memory_authority_immutable BEFORE UPDATE OF memory_authority ON chat.messages FOR EACH ROW EXECUTE FUNCTION chat.reject_message_memory_authority_mutation()') FROM pg_trigger WHERE tgrelid='chat.messages'::regclass AND tgname='message_memory_authority_immutable' AND NOT tgisinternal;"
must_be_true "memory reconcile index is usable" \
  "SELECT count(*) = 1 AND bool_and(NOT i.indisunique AND i.indisvalid AND i.indisready AND i.indislive AND pg_get_indexdef(i.indexrelid) = 'CREATE INDEX messages_memory_reconcile_eligible_idx ON chat.messages USING btree (updated_at DESC) WHERE ((role = ''assistant''::text) AND (status = ''sent''::text) AND (deleted_at IS NULL) AND (memory_authority = ''enabled''::text) AND (memory_extracted_attempt < attempt) AND (reply_to_message_id IS NOT NULL))') FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid='chat.messages'::regclass AND c.relname='messages_memory_reconcile_eligible_idx';"
must_be_true "Scene constraints are complete" \
  "SELECT count(*) = 3 AND bool_and(convalidated) FROM pg_constraint WHERE conrelid='chat.chat_scene_revisions'::regclass AND conname IN ('chat_scene_revisions_version_check','chat_scene_revisions_source_attempt_check','chat_scene_revisions_snapshot_schema_check') AND pg_get_constraintdef(oid) IN ('CHECK ((version > 0))','CHECK ((source_attempt > 0))','CHECK (((snapshot @> ''{\"schemaVersion\": 1}''::jsonb) AND (((snapshot ->> ''version''::text))::integer = version)))');"
must_be_true "Scene indexes are usable" \
  "SELECT count(*) = 3 AND bool_and(i.indisvalid AND i.indisready AND i.indislive AND i.indisunique = (c.relname IN ('chat_scene_revisions_session_version_key','chat_scene_revisions_source_attempt_key'))) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid='chat.chat_scene_revisions'::regclass AND c.relname IN ('chat_scene_revisions_session_version_key','chat_scene_revisions_source_attempt_key','chat_scene_revisions_session_created_idx') AND pg_get_indexdef(i.indexrelid) IN ('CREATE UNIQUE INDEX chat_scene_revisions_session_version_key ON chat.chat_scene_revisions USING btree (session_id, version)','CREATE UNIQUE INDEX chat_scene_revisions_source_attempt_key ON chat.chat_scene_revisions USING btree (source_assistant_message_id, source_attempt)','CREATE INDEX chat_scene_revisions_session_created_idx ON chat.chat_scene_revisions USING btree (session_id, created_at)');"
must_be_true "send receipt columns are complete" \
  "SELECT count(*) = 10 AND bool_and(CASE column_name WHEN 'safety_policy_code' THEN is_nullable='YES' ELSE is_nullable='NO' END) FROM information_schema.columns WHERE table_schema='chat' AND table_name='chat_send_receipts' AND column_name IN ('id','user_id','session_id','idempotency_key','request_hash','user_message_id','assistant_message_id','response_status','safety_policy_code','created_at');"
must_be_true "send receipt constraints are exact" \
  "SELECT count(*) = 3 AND bool_and(convalidated) FROM pg_constraint WHERE conrelid='chat.chat_send_receipts'::regclass AND conname IN ('chat_send_receipts_pkey','chat_send_receipts_session_id_fkey','chat_send_receipts_response_status_check') AND pg_get_constraintdef(oid) IN ('PRIMARY KEY (id)','FOREIGN KEY (session_id) REFERENCES chat.chat_sessions(id) ON DELETE CASCADE','CHECK ((response_status = ANY (ARRAY[''generating''::text, ''blocked''::text])))');"
must_be_true "send receipt indexes are exact and usable" \
  "SELECT count(*) = 2 AND bool_and(i.indisvalid AND i.indisready AND i.indislive AND i.indisunique = (c.relname='chat_send_receipts_user_idempotency_key')) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid='chat.chat_send_receipts'::regclass AND c.relname IN ('chat_send_receipts_user_idempotency_key','chat_send_receipts_session_idx') AND pg_get_indexdef(i.indexrelid) IN ('CREATE UNIQUE INDEX chat_send_receipts_user_idempotency_key ON chat.chat_send_receipts USING btree (user_id, idempotency_key)','CREATE INDEX chat_send_receipts_session_idx ON chat.chat_send_receipts USING btree (session_id)');"
must_be_true "file mutation redaction and trigger authority are canonical" \
  "SELECT to_regprocedure('chat.redact_file_mutation_payload(text,text,jsonb)') IS NOT NULL AND chat.redact_file_mutation_payload('validation-file-mutation','account_delete',jsonb_build_object('kind','account_delete','deletionRequestEventId','validation-request','requestBound',true)) = jsonb_build_object('kind','account_delete','deletionRequestEventId','validation-request','requestBound',true) AND (SELECT count(*) = 1 AND bool_and(t.tgenabled IN ('O', 'A') AND t.tgtype = 31 AND t.tgqual IS NULL AND t.tgattr::text = '' AND t.tgfoid = to_regprocedure('chat.assert_file_mutation_update()')) FROM pg_trigger t WHERE t.tgrelid='chat.chat_file_mutations'::regclass AND t.tgname='chat_file_mutations_immutable' AND NOT t.tgisinternal) AND position('chat.redact_file_mutation_payload(OLD.id,OLD.kind,OLD.payload)' IN regexp_replace((SELECT p.prosrc FROM pg_proc p WHERE p.oid=to_regprocedure('chat.assert_file_mutation_update()')),'[[:space:]]','','g')) > 0 AND position('chat.redact_file_mutation_payload(OLD.kind,OLD.payload)' IN regexp_replace((SELECT p.prosrc FROM pg_proc p WHERE p.oid=to_regprocedure('chat.assert_file_mutation_update()')),'[[:space:]]','','g')) = 0;"
must_be_true "request role has append-only Scene authority" \
  "SELECT has_table_privilege('chat_service','chat.chat_scene_revisions','SELECT') AND has_table_privilege('chat_service','chat.chat_scene_revisions','INSERT') AND NOT has_table_privilege('chat_service','chat.chat_scene_revisions','UPDATE') AND NOT has_table_privilege('chat_service','chat.chat_scene_revisions','DELETE');"
must_be_true "projector has no Scene authority" \
  "SELECT NOT has_table_privilege('chat_projector','chat.chat_scene_revisions','SELECT') AND NOT has_table_privilege('chat_projector','chat.chat_scene_revisions','INSERT') AND NOT has_table_privilege('chat_projector','chat.chat_scene_revisions','UPDATE') AND NOT has_table_privilege('chat_projector','chat.chat_scene_revisions','DELETE');"
must_be_true "runtime roles have the exact least-privilege catalog matrix" \
  "WITH runtime_roles(role_name) AS (
     VALUES ('chat_service'), ('chat_projector')
   ), chat_relations AS (
     SELECT class.oid AS relation, class.relname
     FROM pg_class AS class
     JOIN pg_namespace AS namespace ON namespace.oid=class.relnamespace
     WHERE namespace.nspname='chat'
       AND class.relkind IN ('r','p','v','m','f')
   ), expected_relations AS (
     SELECT role_name, relation, relname,
       CASE role_name
         WHEN 'chat_service' THEN relname IN ('chat_sessions','chat_send_receipts','chat_session_release_migrations','messages','message_attachments','message_versions','chat_usage','chat_moderation_events','chat_outbox_events','chat_inbox_events','chat_scene_revisions','chat_file_mutations')
         WHEN 'chat_projector' THEN relname IN ('chat_sessions','chat_send_receipts','messages','chat_outbox_events','chat_file_mutations')
         ELSE false
       END AS can_select,
       CASE role_name
         WHEN 'chat_service' THEN relname IN ('chat_sessions','chat_send_receipts','chat_session_release_migrations','messages','message_attachments','message_versions','chat_usage','chat_moderation_events','chat_outbox_events','chat_inbox_events','chat_scene_revisions')
         WHEN 'chat_projector' THEN false
         ELSE false
       END AS can_insert,
       CASE role_name
         WHEN 'chat_service' THEN relname IN ('chat_sessions','chat_send_receipts','chat_session_release_migrations','messages','message_attachments','message_versions','chat_usage','chat_moderation_events','chat_outbox_events','chat_inbox_events')
         WHEN 'chat_projector' THEN false
         ELSE false
       END AS can_update,
       role_name='chat_service' AND relname IN ('chat_sessions','chat_send_receipts','chat_session_release_migrations','messages','message_attachments','message_versions','chat_usage','chat_moderation_events','chat_outbox_events','chat_inbox_events') AS can_delete
     FROM runtime_roles CROSS JOIN chat_relations
   ), table_drift AS (
     SELECT 1 FROM expected_relations
     WHERE has_table_privilege(role_name,relation,'SELECT') IS DISTINCT FROM can_select
        OR has_table_privilege(role_name,relation,'INSERT') IS DISTINCT FROM can_insert
        OR has_table_privilege(role_name,relation,'UPDATE') IS DISTINCT FROM can_update
        OR has_table_privilege(role_name,relation,'DELETE') IS DISTINCT FROM can_delete
        OR has_table_privilege(role_name,relation,'TRUNCATE')
        OR has_table_privilege(role_name,relation,'REFERENCES')
        OR has_table_privilege(role_name,relation,'TRIGGER')
   ), column_drift AS (
     SELECT 1
     FROM expected_relations
     JOIN pg_attribute AS attribute
       ON attribute.attrelid=expected_relations.relation
      AND attribute.attnum>0 AND NOT attribute.attisdropped
     WHERE has_column_privilege(role_name,relation,attribute.attname,'SELECT') IS DISTINCT FROM can_select
        OR has_column_privilege(role_name,relation,attribute.attname,'INSERT') IS DISTINCT FROM (
          can_insert
          OR (role_name='chat_service' AND relname='chat_file_mutations' AND attribute.attname IN ('id','user_id','kind','payload'))
          OR (role_name='chat_projector' AND relname='chat_outbox_events' AND attribute.attname IN ('id','event_type','aggregate_type','aggregate_id','payload','schema_version','status','attempts','next_run_at','created_at'))
        )
        OR has_column_privilege(role_name,relation,attribute.attname,'UPDATE') IS DISTINCT FROM (
          can_update
          OR (role_name='chat_projector' AND relname='chat_sessions' AND attribute.attname IN ('log_extracted_seq','updated_at'))
          OR (role_name='chat_projector' AND relname='messages' AND attribute.attname IN ('memory_extracted_attempt','updated_at'))
          OR (role_name='chat_projector' AND relname='chat_file_mutations' AND attribute.attname IN ('status','payload','attempts','last_error','applied_at'))
        )
        OR has_column_privilege(role_name,relation,attribute.attname,'REFERENCES')
   ), authority_views AS (
     SELECT class.oid AS relation
     FROM pg_class AS class
     JOIN pg_namespace AS namespace ON namespace.oid=class.relnamespace
     WHERE (namespace.nspname,class.relname) IN (('core','chat_user_view'),('core','chat_character_view'),('core','chat_character_content_version_view'),('core','chat_character_release_view'),('core','chat_character_tags_view'),('billing','chat_entitlement_view'),('compliance','chat_user_eligibility_view'))
   ), view_drift AS (
     SELECT 1 FROM runtime_roles CROSS JOIN authority_views
     WHERE has_table_privilege(role_name,relation,'SELECT') IS DISTINCT FROM (role_name='chat_service')
        OR has_table_privilege(role_name,relation,'INSERT')
        OR has_table_privilege(role_name,relation,'UPDATE')
        OR has_table_privilege(role_name,relation,'DELETE')
        OR has_table_privilege(role_name,relation,'TRUNCATE')
        OR has_table_privilege(role_name,relation,'REFERENCES')
        OR has_table_privilege(role_name,relation,'TRIGGER')
        OR has_any_column_privilege(role_name,relation,'INSERT,UPDATE,REFERENCES')
   ), application_schemas(schema_name) AS (
     VALUES ('chat'),('core'),('billing'),('compliance'),('public')
   ), schema_drift AS (
     SELECT 1 FROM runtime_roles CROSS JOIN application_schemas
     WHERE (schema_name <> 'public' AND has_schema_privilege(role_name,schema_name,'USAGE') IS DISTINCT FROM (
       (role_name='chat_service' AND schema_name IN ('chat','core','billing','compliance')) OR
       (role_name='chat_projector' AND schema_name='chat')
     )) OR has_schema_privilege(role_name,schema_name,'CREATE')
   ), chat_sequences AS (
     SELECT class.oid AS relation, class.relname
     FROM pg_class AS class
     JOIN pg_namespace AS namespace ON namespace.oid=class.relnamespace
     WHERE namespace.nspname='chat' AND class.relkind='S'
   ), sequence_drift AS (
     SELECT 1 FROM runtime_roles CROSS JOIN chat_sequences
     WHERE has_sequence_privilege(role_name,relation,'USAGE') IS DISTINCT FROM (role_name='chat_service' AND relname='chat_file_mutations_sequence_seq')
        OR has_sequence_privilege(role_name,relation,'SELECT')
        OR has_sequence_privilege(role_name,relation,'UPDATE')
   ), chat_functions AS (
     SELECT procedure.oid AS procedure
     FROM pg_proc AS procedure
     JOIN pg_namespace AS namespace ON namespace.oid=procedure.pronamespace
     WHERE namespace.nspname='chat'
   ), function_drift AS (
     SELECT 1 FROM runtime_roles CROSS JOIN chat_functions
     WHERE has_function_privilege(role_name,procedure,'EXECUTE') IS DISTINCT FROM CASE role_name
       WHEN 'chat_service' THEN procedure IN (to_regprocedure('chat.redact_file_mutation_payload(text,text,jsonb)'),to_regprocedure('chat.purge_file_mutations_for_account(text,text)'))
       WHEN 'chat_projector' THEN procedure IN (to_regprocedure('chat.redact_file_mutation_payload(text,text,jsonb)'),to_regprocedure('chat.purge_file_mutations_for_account(text,text)'),to_regprocedure('chat.purge_applied_relationship_sets(text,text,bigint)'))
       ELSE false END
   ), public_tables AS (
     SELECT class.oid AS relation
     FROM pg_class AS class
     JOIN pg_namespace AS namespace ON namespace.oid=class.relnamespace
     WHERE namespace.nspname='public' AND class.relkind IN ('r','p','v','m','f')
   ), public_drift AS (
     SELECT 1 FROM runtime_roles CROSS JOIN public_tables
     WHERE has_table_privilege(role_name,relation,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(role_name,relation,'SELECT,INSERT,UPDATE,REFERENCES')
   ), default_drift AS (
     SELECT 1 FROM (
       SELECT expanded.grantee
       FROM pg_roles AS owner_role
       CROSS JOIN (VALUES ('r'::\"char\"),('S'::\"char\"),('f'::\"char\")) AS object_type(code)
       CROSS JOIN LATERAL aclexplode(COALESCE(
         (SELECT defaults.defaclacl FROM pg_default_acl AS defaults WHERE defaults.defaclrole=owner_role.oid AND defaults.defaclnamespace=0 AND defaults.defaclobjtype=object_type.code),
         acldefault(object_type.code,owner_role.oid)
       )) AS expanded
       WHERE owner_role.rolname='chat_owner'
       UNION ALL
       SELECT expanded.grantee
       FROM pg_roles AS owner_role
       JOIN pg_default_acl AS defaults
         ON defaults.defaclrole=owner_role.oid
        AND defaults.defaclnamespace=(SELECT oid FROM pg_namespace WHERE nspname='chat')
        AND defaults.defaclobjtype IN ('r','S','f')
       CROSS JOIN LATERAL aclexplode(defaults.defaclacl) AS expanded
       WHERE owner_role.rolname='chat_owner'
     ) AS grants
     LEFT JOIN pg_roles AS grantee_role ON grantee_role.oid=grants.grantee
     WHERE grants.grantee=0 OR grantee_role.rolname IN ('chat_service','chat_projector')
   )
   SELECT (SELECT count(*)=7 FROM authority_views)
      AND NOT EXISTS (SELECT 1 FROM table_drift)
      AND NOT EXISTS (SELECT 1 FROM column_drift)
      AND NOT EXISTS (SELECT 1 FROM view_drift)
      AND NOT EXISTS (SELECT 1 FROM schema_drift)
      AND NOT EXISTS (SELECT 1 FROM sequence_drift)
      AND NOT EXISTS (SELECT 1 FROM function_drift)
      AND NOT EXISTS (SELECT 1 FROM public_drift)
      AND NOT EXISTS (SELECT 1 FROM default_drift);"

echo "== positive: chat_service CAN read the authority views + write chat.* =="
psql_chat -U chat_service -d "$DB" -c "SELECT data_class, count(*) FROM core.chat_user_view GROUP BY data_class;" >/dev/null
psql_chat -U chat_service -d "$DB" -c "SELECT count(*) FROM core.chat_character_view;" >/dev/null
psql_chat -U chat_service -d "$DB" -c "SELECT count(*) FROM core.chat_character_content_version_view;" >/dev/null
psql_chat -U chat_service -d "$DB" -c "SELECT count(*) FROM core.chat_character_release_view;" >/dev/null
psql_chat -U chat_service -d "$DB" -c "SELECT count(*) FROM billing.chat_entitlement_view;" >/dev/null
psql_chat -U chat_service -d "$DB" -c "SELECT count(*) FROM compliance.chat_user_eligibility_view;" >/dev/null
psql_chat -U chat_service -d "$DB" -c "SELECT engagement_session_id, character_content_version_id, character_release_id, memory_authority, scene_version, runtime_trace FROM chat.messages LIMIT 0;" >/dev/null
psql_chat -U chat_service -d "$DB" -c "SELECT character_content_version_id, character_release_id, entry_exposure_id, entry_journey_id, entry_placement_id, context_revision FROM chat.chat_sessions LIMIT 0;" >/dev/null
psql_chat -U chat_service -d "$DB" -c "SELECT runtime_trace FROM chat.message_versions LIMIT 0;" >/dev/null
psql_chat -U chat_service -d "$DB" -c "SELECT session_id, version, source_assistant_message_id, source_attempt, snapshot FROM chat.chat_scene_revisions LIMIT 0;" >/dev/null
psql_chat -U chat_service -d "$DB" -c "SELECT source_service, source_event_id, payload_hash, processed_at FROM chat.chat_inbox_events LIMIT 0;" >/dev/null
psql_chat -U chat_service -d "$DB" -c "SELECT user_id, idempotency_key, request_hash, user_message_id, assistant_message_id, response_status, safety_policy_code FROM chat.chat_send_receipts LIMIT 0;" >/dev/null
psql_chat -U chat_service -d "$DB" -c "SELECT command_id, to_character_content_version_id, status FROM chat.chat_session_release_migrations LIMIT 0;" >/dev/null
psql_chat -U chat_service -d "$DB" -c "SELECT user_id, kind, payload, status FROM chat.chat_file_mutations LIMIT 0;" >/dev/null
psql_chat -U chat_service -d "$DB" -c "INSERT INTO chat.chat_sessions (id,user_id,character_id) VALUES ('$SESSION_ID','$USER_ID','$CHARACTER_ID');" >/dev/null
psql_chat -U chat_service -d "$DB" -c "INSERT INTO chat.chat_send_receipts (id,user_id,session_id,idempotency_key,request_hash,user_message_id,assistant_message_id,response_status) VALUES ('$RECEIPT_ID','$USER_ID','$SESSION_ID','${VALIDATION_PREFIX}_send_key','${VALIDATION_PREFIX}_request_hash','${VALIDATION_PREFIX}_user_message','${VALIDATION_PREFIX}_assistant_message','generating');" >/dev/null
psql_chat -U chat_service -d "$DB" -c "INSERT INTO chat.messages (id,session_id,role,status,memory_authority) VALUES ('$MESSAGE_ID','$SESSION_ID','assistant','sent','enabled');" >/dev/null
psql_chat -U chat_service -d "$DB" -c "INSERT INTO chat.chat_scene_revisions (id,session_id,version,source_assistant_message_id,source_attempt,snapshot) VALUES ('${VALIDATION_PREFIX}_scene1','$SESSION_ID',1,'$MESSAGE_ID',1,'{\"schemaVersion\":1,\"version\":1}');" >/dev/null
psql_chat -U chat_service -d "$DB" -c "INSERT INTO chat.chat_file_mutations (id,user_id,kind,payload) VALUES ('$FILE_MUTATION_ID','$USER_ID','trace_append','{\"kind\":\"trace_append\",\"sessionId\":\"$SESSION_ID\",\"entry\":{\"secret\":\"must-redact\"}}');" >/dev/null
psql_projector -U chat_projector -d "$DB" -c "SELECT user_id FROM chat.chat_sessions WHERE id='$SESSION_ID'; SELECT assistant_message_id FROM chat.chat_send_receipts WHERE id='$RECEIPT_ID'; UPDATE chat.chat_sessions SET log_extracted_seq=log_extracted_seq,updated_at=timezone('utc',now()) WHERE id='$SESSION_ID'; UPDATE chat.messages SET memory_extracted_attempt=memory_extracted_attempt,updated_at=timezone('utc',now()) WHERE id='$MESSAGE_ID'; INSERT INTO chat.chat_outbox_events (id,event_type,aggregate_type,aggregate_id,payload,schema_version,status,attempts,next_run_at,created_at) VALUES ('$PROJECTOR_OUTBOX_ID','chat.validation','validation','$USER_ID','{}',1,'pending',0,timezone('utc',now()),timezone('utc',now())) RETURNING *;" >/dev/null
psql_projector -U chat_projector -d "$DB" -c "UPDATE chat.chat_file_mutations SET status='applied', payload=chat.redact_file_mutation_payload(id,kind,payload), attempts=attempts+1, applied_at=timezone('utc',now()) WHERE id='$FILE_MUTATION_ID';" >/dev/null
echo "  OK: views readable, request CRUD and narrow projector SQL surface writable"

# Negative test helper: a statement that MUST be rejected.
must_reject() {
  local label="$1"; local sql="$2"
  if psql_chat -U chat_service -d "$DB" -c "$sql" >/dev/null 2>&1; then
    echo "  FAIL: '$label' was ALLOWED but must be denied"; exit 1
  else
    echo "  OK (denied): $label"
  fi
}
must_reject_projector() {
  local label="$1"; local sql="$2"
  if psql_projector -U chat_projector -d "$DB" -c "$sql" >/dev/null 2>&1; then
    echo "  FAIL: '$label' was ALLOWED but must be denied"; exit 1
  else
    echo "  OK (denied): $label"
  fi
}

echo "== negative: boundary must reject these =="
must_reject "INSERT public.users"          "INSERT INTO public.users (id,email) VALUES ('x','x@x');"
must_reject "UPDATE public.users"          "UPDATE public.users SET status='suspended';"
must_reject "SELECT public.users"          "SELECT * FROM public.users LIMIT 1;"
must_reject "SELECT public.entitlements"   "SELECT * FROM public.entitlements LIMIT 1;"
must_reject "INSERT core.chat_user_view"   "INSERT INTO core.chat_user_view (user_id) VALUES ('x');"
must_reject "UPDATE billing view"          "UPDATE billing.chat_entitlement_view SET model_tier='deluxe';"
must_reject "CREATE in chat schema"        "CREATE TABLE chat.${VALIDATION_PREFIX}_request_create (id integer);"
must_reject "TRUNCATE chat table"          "TRUNCATE chat.chat_usage;"
must_reject "REFERENCES chat table"        "CREATE TEMP TABLE ${VALIDATION_PREFIX}_request_reference (usage_id text REFERENCES chat.chat_usage(id));"
must_reject "TRIGGER on chat table"        "CREATE TRIGGER ${VALIDATION_PREFIX}_request_trigger BEFORE UPDATE ON chat.chat_usage FOR EACH ROW EXECUTE FUNCTION chat.reject_message_memory_authority_mutation();"
must_reject "EXECUTE legacy redactor"      "SELECT chat.redact_file_mutation_payload('trace_append','{\"kind\":\"trace_append\"}'::jsonb);"
must_reject "UPDATE turn memory authority" "UPDATE chat.messages SET memory_authority='disabled' WHERE id='$MESSAGE_ID';"
must_reject "duplicate send idempotency receipt" "INSERT INTO chat.chat_send_receipts (id,user_id,session_id,idempotency_key,request_hash,user_message_id,assistant_message_id,response_status) VALUES ('${RECEIPT_ID}_duplicate','$USER_ID','$SESSION_ID','${VALIDATION_PREFIX}_send_key','different_hash','different_user_message','different_assistant_message','generating');"
must_reject "invalid send response status" "INSERT INTO chat.chat_send_receipts (id,user_id,session_id,idempotency_key,request_hash,user_message_id,assistant_message_id,response_status) VALUES ('${RECEIPT_ID}_invalid','$USER_ID','$SESSION_ID','${VALIDATION_PREFIX}_invalid_key','different_hash','different_user_message','different_assistant_message','sent');"
must_reject "UPDATE immutable Scene revision" "UPDATE chat.chat_scene_revisions SET snapshot='{\"schemaVersion\":1,\"version\":1}'::jsonb WHERE id='${VALIDATION_PREFIX}_scene1';"
must_reject "DELETE immutable Scene revision" "DELETE FROM chat.chat_scene_revisions WHERE id='${VALIDATION_PREFIX}_scene1';"
must_reject "DELETE pending file intent"    "INSERT INTO chat.chat_file_mutations (id,user_id,kind,payload) VALUES ('$PENDING_FILE_MUTATION_ID','$USER_ID','account_delete','{\"kind\":\"account_delete\"}'); DELETE FROM chat.chat_file_mutations WHERE id='$PENDING_FILE_MUTATION_ID';"
must_reject "forge applied file intent"     "INSERT INTO chat.chat_file_mutations (id,user_id,kind,payload) VALUES ('$FORGED_FILE_MUTATION_ID','$USER_ID','account_delete','{\"kind\":\"account_delete\"}'); UPDATE chat.chat_file_mutations SET status='applied' WHERE id='$FORGED_FILE_MUTATION_ID';"
must_reject "inject file intent sequence"   "INSERT INTO chat.chat_file_mutations (id,sequence,user_id,kind,payload) VALUES ('$SEQUENCE_FILE_MUTATION_ID',-1,'$USER_ID','account_delete','{\"kind\":\"account_delete\"}');"
must_reject "mutate applied file receipt"   "UPDATE chat.chat_file_mutations SET payload='{\"kind\":\"trace_append\",\"sessionId\":\"changed\"}'::jsonb WHERE id='$FILE_MUTATION_ID';"
must_reject "account purge without canonical intent" "SELECT chat.purge_file_mutations_for_account('$USER_ID','$FILE_MUTATION_ID');"
must_reject_projector "account purge without erasure intent" "SELECT chat.purge_file_mutations_for_account('$USER_ID','$FILE_MUTATION_ID');"
must_reject_projector "relationship purge without reset intent" "SELECT chat.purge_applied_relationship_sets('$USER_ID','$CHARACTER_ID',9223372036854775807);"
must_reject_projector "projector SELECT Scene revision" "SELECT * FROM chat.chat_scene_revisions LIMIT 1;"
must_reject_projector "projector INSERT Scene revision" "INSERT INTO chat.chat_scene_revisions (id,session_id,version,source_assistant_message_id,source_attempt,snapshot) VALUES ('${VALIDATION_PREFIX}_scene_projector','$SESSION_ID',2,'${MESSAGE_ID}_projector',1,'{\"schemaVersion\":1,\"version\":2}');"
must_reject_projector "projector SELECT public.users" "SELECT * FROM public.users LIMIT 1;"
must_reject_projector "projector SELECT public.entitlements" "SELECT * FROM public.entitlements LIMIT 1;"
must_reject_projector "projector CREATE in chat schema" "CREATE TABLE chat.${VALIDATION_PREFIX}_projector_create (id integer);"
must_reject_projector "projector SELECT unrelated chat table" "SELECT * FROM chat.chat_usage LIMIT 1;"
must_reject_projector "projector INSERT chat session" "INSERT INTO chat.chat_sessions (id,user_id,character_id) VALUES ('${VALIDATION_PREFIX}_projector_session','$USER_ID','$CHARACTER_ID');"
must_reject_projector "projector DELETE chat session" "DELETE FROM chat.chat_sessions WHERE id='$SESSION_ID';"
must_reject_projector "projector UPDATE session title" "UPDATE chat.chat_sessions SET title='forged' WHERE id='$SESSION_ID';"
must_reject_projector "projector UPDATE message content" "UPDATE chat.messages SET content='forged' WHERE id='$MESSAGE_ID';"
must_reject_projector "projector UPDATE outbox" "UPDATE chat.chat_outbox_events SET status='delivered' WHERE id='$PROJECTOR_OUTBOX_ID';"
must_reject_projector "projector INSERT outbox delivered_at" "INSERT INTO chat.chat_outbox_events (id,event_type,aggregate_type,aggregate_id,delivered_at) VALUES ('${PROJECTOR_OUTBOX_ID}_forged','chat.validation','validation','$USER_ID',timezone('utc',now()));"
must_reject_projector "projector sequence usage" "SELECT nextval('chat.chat_file_mutations_sequence_seq');"
must_reject_projector "projector EXECUTE legacy redactor" "SELECT chat.redact_file_mutation_payload('trace_append','{\"kind\":\"trace_append\"}'::jsonb);"

if [[ "$(psql_super -U "$SUPER" -d "$DB" -tAc "SELECT has_function_privilege('chat_service','chat.purge_applied_relationship_sets(text,text,bigint)','EXECUTE');" | tr -d '[:space:]')" != "f" ]]; then
  echo "  FAIL: chat_service retained relationship purge EXECUTE"; exit 1
fi
echo "  OK (denied): request role relationship purge capability"
psql_chat -U chat_service -d "$DB" -c "INSERT INTO chat.chat_file_mutations (id,user_id,kind,payload) VALUES ('$RELATIONSHIP_MUTATION_ID','$USER_ID','relationship_delete','{\"kind\":\"relationship_delete\",\"characterId\":\"$CHARACTER_ID\"}');" >/dev/null
must_reject "request role canonical relationship purge" "SELECT chat.purge_applied_relationship_sets('$USER_ID','$CHARACTER_ID',(SELECT sequence FROM chat.chat_file_mutations WHERE id='$RELATIONSHIP_MUTATION_ID'));"
psql_projector -U chat_projector -d "$DB" -c "SELECT chat.purge_applied_relationship_sets('$USER_ID','$CHARACTER_ID',(SELECT sequence FROM chat.chat_file_mutations WHERE id='$RELATIONSHIP_MUTATION_ID'));" >/dev/null

psql_chat -U chat_service -d "$DB" -c "INSERT INTO chat.chat_file_mutations (id,user_id,kind,payload) VALUES ('$ERASURE_MUTATION_ID','$USER_ID','account_delete','{\"kind\":\"account_delete\"}');" >/dev/null
psql_chat -U chat_service -d "$DB" -c "SELECT chat.purge_file_mutations_for_account('$USER_ID','$ERASURE_MUTATION_ID');" >/dev/null
psql_projector -U chat_projector -d "$DB" -c "UPDATE chat.chat_file_mutations SET status='applied', payload=chat.redact_file_mutation_payload(id,kind,payload), attempts=attempts+1, applied_at=timezone('utc',now()) WHERE id='$ERASURE_MUTATION_ID'; SELECT chat.purge_file_mutations_for_account('$USER_ID','$ERASURE_MUTATION_ID');" >/dev/null
psql_chat -U chat_service -d "$DB" -c "DELETE FROM chat.chat_outbox_events WHERE id='$PROJECTOR_OUTBOX_ID';" >/dev/null
psql_super -U "$SUPER" -d "$DB" -c "DELETE FROM chat.chat_scene_revisions WHERE id='${VALIDATION_PREFIX}_scene1';" >/dev/null
psql_chat -U chat_service -d "$DB" -c "DELETE FROM chat.chat_send_receipts WHERE id='$RECEIPT_ID';" >/dev/null
psql_chat -U chat_service -d "$DB" -c "DELETE FROM chat.messages WHERE id='$MESSAGE_ID'; DELETE FROM chat.chat_sessions WHERE id='$SESSION_ID';" >/dev/null

echo "ALL P0-1 BOUNDARY CHECKS PASSED"
