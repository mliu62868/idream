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

echo "== applying boundary SQL to $DB =="
psql_super -U "$SUPER" -d "$DB" -f "$HERE/01_schemas_roles.sql"
psql_super -U "$SUPER" -d "$DB" -c "SET ROLE core_owner;" -f "$HERE/02_core_views.sql"
psql_super -U "$SUPER" -d "$DB" -c "SET ROLE core_owner;" -f "$HERE/2026-07-18-chat-user-data-class-authority.sql"
psql_super -U "$SUPER" -d "$DB" -f "$HERE/03_character_management.sql"
psql_super -U "$SUPER" -d "$DB" -c "SET ROLE core_owner;" -f "$HERE/2026-07-08-chat-visual-passport-and-tool-flags.sql"
psql_super -U "$SUPER" -d "$DB" -c "SET ROLE chat_owner;" -f "$HERE/03_chat_tables.sql"
psql_super -U "$SUPER" -d "$DB" -c "SET ROLE chat_owner;" -f "$HERE/2026-07-16-chat-send-idempotency.sql"
psql_super -U "$SUPER" -d "$DB" -c "SET ROLE chat_owner;" -f "$HERE/2026-07-18-chat-turn-memory-authority.sql"
psql_super -U "$SUPER" -d "$DB" -c "SET ROLE chat_owner;" -f "$HERE/2026-07-18-chat-file-mutation-authority.sql"
psql_super -U "$SUPER" -d "$DB" -c "SET ROLE chat_owner;" -f "$HERE/2026-07-18-chat-context-revision-authority.sql"
psql_super -U "$SUPER" -d "$DB" -f "$HERE/04_grants.sql"
psql_super -U "$SUPER" -d "$DB" -f "$HERE/2026-07-11-chat-session-release-pin.sql"
psql_super -U "$SUPER" -d "$DB" -f "$HERE/2026-07-11-chat-exchange-v2.sql"
psql_super -U "$SUPER" -d "$DB" -f "$HERE/2026-07-11-chat-entry-attribution.sql"
psql_super -U "$SUPER" -d "$DB" -f "$HERE/2026-07-12-chat-inbox-receipt-truth.sql"
echo "== applied =="

echo "== positive: chat_service CAN read the authority views + write chat.* =="
psql_chat -U chat_service -d "$DB" -c "SELECT data_class, count(*) FROM core.chat_user_view GROUP BY data_class;" >/dev/null
psql_chat -U chat_service -d "$DB" -c "SELECT count(*) FROM core.chat_character_view;" >/dev/null
psql_chat -U chat_service -d "$DB" -c "SELECT count(*) FROM core.chat_character_content_version_view;" >/dev/null
psql_chat -U chat_service -d "$DB" -c "SELECT count(*) FROM core.chat_character_release_view;" >/dev/null
psql_chat -U chat_service -d "$DB" -c "SELECT count(*) FROM billing.chat_entitlement_view;" >/dev/null
psql_chat -U chat_service -d "$DB" -c "SELECT count(*) FROM compliance.chat_user_eligibility_view;" >/dev/null
psql_chat -U chat_service -d "$DB" -c "SELECT engagement_session_id, character_content_version_id, character_release_id, memory_authority FROM chat.messages LIMIT 0;" >/dev/null
psql_chat -U chat_service -d "$DB" -c "SELECT character_content_version_id, character_release_id, entry_exposure_id, entry_journey_id, entry_placement_id, context_revision FROM chat.chat_sessions LIMIT 0;" >/dev/null
psql_chat -U chat_service -d "$DB" -c "SELECT source_service, source_event_id, payload_hash, processed_at FROM chat.chat_inbox_events LIMIT 0;" >/dev/null
psql_chat -U chat_service -d "$DB" -c "SELECT user_id, idempotency_key, request_hash, user_message_id, assistant_message_id FROM chat.chat_send_receipts LIMIT 0;" >/dev/null
psql_chat -U chat_service -d "$DB" -c "SELECT command_id, to_character_content_version_id, status FROM chat.chat_session_release_migrations LIMIT 0;" >/dev/null
psql_chat -U chat_service -d "$DB" -c "SELECT user_id, kind, payload, status FROM chat.chat_file_mutations LIMIT 0;" >/dev/null
psql_chat -U chat_service -d "$DB" -c "INSERT INTO chat.chat_sessions (id,user_id,character_id) VALUES ('val_s1','val_u1','val_c1');" >/dev/null
psql_chat -U chat_service -d "$DB" -c "INSERT INTO chat.messages (id,session_id,role,status,memory_authority) VALUES ('val_m1','val_s1','assistant','sent','enabled');" >/dev/null
psql_chat -U chat_service -d "$DB" -c "INSERT INTO chat.chat_file_mutations (id,user_id,kind,payload) VALUES ('val_fm1','val_u1','trace_append','{\"kind\":\"trace_append\",\"sessionId\":\"val_s1\",\"entry\":{\"secret\":\"must-redact\"}}');" >/dev/null
psql_projector -U chat_projector -d "$DB" -c "UPDATE chat.chat_file_mutations SET status='applied', payload=chat.redact_file_mutation_payload(kind,payload), attempts=attempts+1, applied_at=timezone('utc',now()) WHERE id='val_fm1';" >/dev/null
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
must_reject "UPDATE turn memory authority" "UPDATE chat.messages SET memory_authority='disabled' WHERE id='val_m1';"
must_reject "DELETE pending file intent"    "INSERT INTO chat.chat_file_mutations (id,user_id,kind,payload) VALUES ('val_fm_pending','val_u1','account_delete','{\"kind\":\"account_delete\"}'); DELETE FROM chat.chat_file_mutations WHERE id='val_fm_pending';"
must_reject "forge applied file intent"     "INSERT INTO chat.chat_file_mutations (id,user_id,kind,payload) VALUES ('val_fm_forge','val_u1','account_delete','{\"kind\":\"account_delete\"}'); UPDATE chat.chat_file_mutations SET status='applied' WHERE id='val_fm_forge';"
must_reject "inject file intent sequence"   "INSERT INTO chat.chat_file_mutations (id,sequence,user_id,kind,payload) VALUES ('val_fm_sequence',-1,'val_u1','account_delete','{\"kind\":\"account_delete\"}');"
must_reject "mutate applied file receipt"   "UPDATE chat.chat_file_mutations SET payload='{\"kind\":\"trace_append\",\"sessionId\":\"changed\"}'::jsonb WHERE id='val_fm1';"
must_reject "account purge without canonical intent" "SELECT chat.purge_file_mutations_for_account('val_u1','val_fm1');"
must_reject_projector "account purge without erasure intent" "SELECT chat.purge_file_mutations_for_account('val_u1','val_fm1');"
must_reject_projector "relationship purge without reset intent" "SELECT chat.purge_applied_relationship_sets('val_u1','val_c1',9223372036854775807);"

if [[ "$(psql_super -U "$SUPER" -d "$DB" -tAc "SELECT has_function_privilege('chat_service','chat.purge_applied_relationship_sets(text,text,bigint)','EXECUTE');" | tr -d '[:space:]')" != "f" ]]; then
  echo "  FAIL: chat_service retained relationship purge EXECUTE"; exit 1
fi
echo "  OK (denied): request role relationship purge capability"
psql_chat -U chat_service -d "$DB" -c "INSERT INTO chat.chat_file_mutations (id,user_id,kind,payload) VALUES ('val_fm_rel_reset','val_u1','relationship_delete','{\"kind\":\"relationship_delete\",\"characterId\":\"val_c1\"}');" >/dev/null
must_reject "request role canonical relationship purge" "SELECT chat.purge_applied_relationship_sets('val_u1','val_c1',(SELECT sequence FROM chat.chat_file_mutations WHERE id='val_fm_rel_reset'));"
psql_projector -U chat_projector -d "$DB" -c "SELECT chat.purge_applied_relationship_sets('val_u1','val_c1',(SELECT sequence FROM chat.chat_file_mutations WHERE id='val_fm_rel_reset'));" >/dev/null

psql_chat -U chat_service -d "$DB" -c "INSERT INTO chat.chat_file_mutations (id,user_id,kind,payload) VALUES ('val_fm_erase','val_u1','account_delete','{\"kind\":\"account_delete\"}');" >/dev/null
psql_chat -U chat_service -d "$DB" -c "SELECT chat.purge_file_mutations_for_account('val_u1','val_fm_erase');" >/dev/null
psql_projector -U chat_projector -d "$DB" -c "UPDATE chat.chat_file_mutations SET status='applied', payload=chat.redact_file_mutation_payload(kind,payload), attempts=attempts+1, applied_at=timezone('utc',now()) WHERE id='val_fm_erase'; SELECT chat.purge_file_mutations_for_account('val_u1','val_fm_erase');" >/dev/null
psql_chat -U chat_service -d "$DB" -c "DELETE FROM chat.messages WHERE id='val_m1'; DELETE FROM chat.chat_sessions WHERE id='val_s1';" >/dev/null

echo "ALL P0-1 BOUNDARY CHECKS PASSED"
