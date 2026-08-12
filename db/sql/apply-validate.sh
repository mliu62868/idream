#!/usr/bin/env bash
# Apply the P0-1 boundary SQL to a target DB with the correct executing roles,
# then prove the boundary has teeth (negative permission tests).
# Usage: DB=idream_split_val SUPER=kk bash db/sql/apply-validate.sh
set -euo pipefail
DB="${DB:-idream_split_val}"
SUPER="${SUPER:-kk}"
HERE="$(cd "$(dirname "$0")" && pwd)"
psql_super() {
  PGPASSWORD="${SUPER_PASSWORD:-${PGPASSWORD:-}}" command psql -v ON_ERROR_STOP=1 -q "$@"
}
psql_chat() {
  PGPASSWORD="${CHAT_SERVICE_PASSWORD:-${PGPASSWORD:-}}" command psql -v ON_ERROR_STOP=1 -q "$@"
}
psql_projector() {
  PGPASSWORD="${CHAT_PROJECTOR_PASSWORD:-${PGPASSWORD:-}}" command psql -v ON_ERROR_STOP=1 -q "$@"
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

echo "== applying boundary SQL to $DB =="
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
  "SELECT count(*) = 1 AND bool_and(tgenabled <> 'D' AND pg_get_triggerdef(oid) = 'CREATE TRIGGER message_memory_authority_immutable BEFORE UPDATE OF memory_authority ON chat.messages FOR EACH ROW EXECUTE FUNCTION chat.reject_message_memory_authority_mutation()') FROM pg_trigger WHERE tgrelid='chat.messages'::regclass AND tgname='message_memory_authority_immutable' AND NOT tgisinternal;"
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
must_be_true "request role has append-only Scene authority" \
  "SELECT has_table_privilege('chat_service','chat.chat_scene_revisions','SELECT') AND has_table_privilege('chat_service','chat.chat_scene_revisions','INSERT') AND NOT has_table_privilege('chat_service','chat.chat_scene_revisions','UPDATE') AND NOT has_table_privilege('chat_service','chat.chat_scene_revisions','DELETE');"
must_be_true "projector has no Scene authority" \
  "SELECT NOT has_table_privilege('chat_projector','chat.chat_scene_revisions','SELECT') AND NOT has_table_privilege('chat_projector','chat.chat_scene_revisions','INSERT') AND NOT has_table_privilege('chat_projector','chat.chat_scene_revisions','UPDATE') AND NOT has_table_privilege('chat_projector','chat.chat_scene_revisions','DELETE');"

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
psql_projector -U chat_projector -d "$DB" -c "UPDATE chat.chat_file_mutations SET status='applied', payload=chat.redact_file_mutation_payload(id,kind,payload), attempts=attempts+1, applied_at=timezone('utc',now()) WHERE id='$FILE_MUTATION_ID';" >/dev/null
echo "  OK: views readable, chat.* writable"

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
psql_super -U "$SUPER" -d "$DB" -c "DELETE FROM chat.chat_scene_revisions WHERE id='${VALIDATION_PREFIX}_scene1';" >/dev/null
psql_chat -U chat_service -d "$DB" -c "DELETE FROM chat.chat_send_receipts WHERE id='$RECEIPT_ID';" >/dev/null
psql_chat -U chat_service -d "$DB" -c "DELETE FROM chat.messages WHERE id='$MESSAGE_ID'; DELETE FROM chat.chat_sessions WHERE id='$SESSION_ID';" >/dev/null

echo "ALL P0-1 BOUNDARY CHECKS PASSED"
