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

echo "== applying boundary SQL to $DB =="
psql_super -U "$SUPER" -d "$DB" -f "$HERE/01_schemas_roles.sql"
psql_super -U "$SUPER" -d "$DB" -c "SET ROLE core_owner;" -f "$HERE/02_core_views.sql"
psql_super -U "$SUPER" -d "$DB" -f "$HERE/03_character_management.sql"
psql_super -U "$SUPER" -d "$DB" -c "SET ROLE chat_owner;" -f "$HERE/03_chat_tables.sql"
psql_super -U "$SUPER" -d "$DB" -f "$HERE/04_grants.sql"
echo "== applied =="

echo "== positive: chat_service CAN read the 4 views + write chat.* =="
psql_chat -U chat_service -d "$DB" -c "SELECT count(*) FROM core.chat_user_view;" >/dev/null
psql_chat -U chat_service -d "$DB" -c "SELECT count(*) FROM core.chat_character_view;" >/dev/null
psql_chat -U chat_service -d "$DB" -c "SELECT count(*) FROM billing.chat_entitlement_view;" >/dev/null
psql_chat -U chat_service -d "$DB" -c "SELECT count(*) FROM compliance.chat_user_eligibility_view;" >/dev/null
psql_chat -U chat_service -d "$DB" -c "INSERT INTO chat.chat_sessions (id,user_id,character_id) VALUES ('val_s1','val_u1','val_c1');" >/dev/null
psql_chat -U chat_service -d "$DB" -c "DELETE FROM chat.chat_sessions WHERE id='val_s1';" >/dev/null
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

echo "== negative: boundary must reject these =="
must_reject "INSERT public.users"          "INSERT INTO public.users (id,email) VALUES ('x','x@x');"
must_reject "UPDATE public.users"          "UPDATE public.users SET status='suspended';"
must_reject "SELECT public.users"          "SELECT * FROM public.users LIMIT 1;"
must_reject "SELECT public.entitlements"   "SELECT * FROM public.entitlements LIMIT 1;"
must_reject "INSERT core.chat_user_view"   "INSERT INTO core.chat_user_view (user_id) VALUES ('x');"
must_reject "UPDATE billing view"          "UPDATE billing.chat_entitlement_view SET model_tier='deluxe';"

echo "ALL P0-1 BOUNDARY CHECKS PASSED"
