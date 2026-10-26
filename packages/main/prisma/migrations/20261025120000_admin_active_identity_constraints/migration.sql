-- Promote the existing manual lifecycle guards into the deployment migration chain.
-- Keep the expressions identical to prisma/manual/2026-08-03-invariant-collapse-check-constraints.sql
-- and the authority fingerprints checked by reconciliation/invariants.ts.
-- This single statement is atomic and never repairs or discards conflicting data.
DO $install_active_identity_constraints$
DECLARE
  expected RECORD;
  actual RECORD;
BEGIN
  FOR expected IN
    SELECT * FROM (VALUES
      (
        'admin_cases',
        'admin_cases_active_key_identity',
        'e599bd00e0c71ee2f3caaa64e31d8ea3',
        $case_check$("activeKey" IS NULL) = (status IN ('closed', 'resolved'))
          AND ("activeKey" IS NULL
            OR "activeKey" = type || ':' || "targetType" || ':' || "targetId" || ':' || "caseKey")$case_check$
      ),
      (
        'ops_incidents',
        'ops_incidents_terminal_releases_active_correlation_key',
        'b1ad33fd15ee005adfe3835aee69d83f',
        $incident_check$NOT (status IN ('resolved', 'closed', 'duplicate', 'merged')
          AND "activeCorrelationKey" IS NOT NULL)$incident_check$
      )
    ) AS checks(table_name, constraint_name, expression_hash, expression)
  LOOP
    SELECT constraint_record.contype, constraint_record.convalidated,
      constraint_record.connoinherit,
      md5(pg_get_expr(constraint_record.conbin, constraint_record.conrelid)) AS expression_hash
    INTO actual
    FROM pg_constraint constraint_record
    WHERE constraint_record.conrelid = format('public.%I', expected.table_name)::regclass
      AND constraint_record.conname = expected.constraint_name;

    IF NOT FOUND THEN
      -- ADD CHECK validates existing rows and rejects the whole migration on a violation.
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%s)',
        expected.table_name, expected.constraint_name, expected.expression);
    ELSIF actual.contype IS DISTINCT FROM 'c'
      OR actual.connoinherit
      OR actual.expression_hash IS DISTINCT FROM expected.expression_hash
    THEN
      RAISE EXCEPTION 'active identity constraint public.%.% has a conflicting definition',
        expected.table_name, expected.constraint_name;
    ELSIF NOT actual.convalidated THEN
      -- A matching NOT VALID guard still needs its historical rows checked.
      EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I',
        expected.table_name, expected.constraint_name);
    END IF;
  END LOOP;
END;
$install_active_identity_constraints$;
