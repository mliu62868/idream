import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

export type ExpectedMigration = {
  readonly migrationName: string;
  readonly checksum: string;
};

export type DatabaseMigration = {
  readonly migration_name: string;
  readonly checksum: string;
  readonly finished_at: Date | string | null;
  readonly rolled_back_at: Date | string | null;
};

export type MigrationAuthority = {
  readonly expectedCount: number;
  readonly appliedCount: number;
  readonly localOnly: readonly string[];
  readonly databaseOnly: readonly string[];
  readonly checksumMismatches: readonly string[];
  readonly incomplete: readonly string[];
  readonly duplicateApplied: readonly string[];
  readonly schemaPostconditionsChecked: boolean;
  readonly schemaPostconditionFailures: readonly string[];
  readonly ok: boolean;
};

export type MigrationPostconditionSnapshot = {
  readonly postgresMajor: number;
  readonly premium: {
    readonly totalCount: number;
    readonly activeCount: number;
    readonly versionOneCount: number;
    readonly versionTwoCount: number;
    readonly legacyIdCount: number;
    readonly replacementIdCount: number;
    readonly freshCanonicalCount: number;
    readonly legacyArchivedCount: number;
    readonly replacementCount: number;
  };
  readonly runtime: {
    readonly retiredRunnerCount: number;
    readonly retiredArtifactStateCount: number;
    readonly profileShadowColumnCount: number;
    readonly runnerDefault: string | null;
  };
  readonly voice: {
    readonly constraintCount: number;
    readonly validated: boolean | null;
    readonly definitionFingerprint: string | null;
  };
  readonly accountDeletion: {
    readonly columns: readonly string[];
    readonly invalidColumns: readonly string[];
    readonly tables: readonly string[];
    readonly constraints: readonly string[];
    readonly invalidConstraints: readonly string[];
    readonly constraintFingerprints: Readonly<Record<string, string>>;
    readonly indexes: readonly string[];
    readonly invalidIndexes: readonly string[];
    readonly triggerCount: number;
    readonly triggerIsConstraint: boolean | null;
    readonly triggerDeferrable: boolean | null;
    readonly triggerInitiallyDeferred: boolean | null;
    readonly triggerEnabled: string | null;
    readonly triggerType: number | null;
    readonly triggerHasWhenClause: boolean | null;
    readonly triggerHasColumnFilter: boolean | null;
    readonly triggerFunction: string | null;
    readonly triggerFunctionFingerprint: string | null;
  };
};

type MigrationAuthorityDatabase = {
  query<T>(sql: string): Promise<{ rows: T[] }>;
};

type PostgreSqlVersionSnapshot = {
  readonly postgresMajor: number;
};

const defaultMigrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../prisma/migrations",
);

// INVARIANT: runtime readiness compares the target database with the exact SQL
// bytes shipped beside the application. A count alone cannot detect a replaced
// migration, a database-only migration, or a failed unfinished deployment.
export function evaluateMigrationAuthority(
  rows: readonly DatabaseMigration[],
  expected: readonly ExpectedMigration[],
): MigrationAuthority {
  const expectedByName = new Map(
    expected.map((migration) => [migration.migrationName, migration.checksum]),
  );
  const incomplete = rows
    .filter((row) => row.finished_at === null && row.rolled_back_at === null)
    .map((row) => row.migration_name)
    .sort();
  const appliedRows = rows.filter(
    (row) => row.finished_at !== null && row.rolled_back_at === null,
  );
  const appliedByName = new Map<string, DatabaseMigration>();
  const duplicateApplied = new Set<string>();
  for (const row of appliedRows) {
    if (appliedByName.has(row.migration_name)) {
      duplicateApplied.add(row.migration_name);
    }
    appliedByName.set(row.migration_name, row);
  }

  const localOnly = expected
    .map((migration) => migration.migrationName)
    .filter((migrationName) => !appliedByName.has(migrationName))
    .sort();
  const databaseOnly = [...appliedByName.keys()]
    .filter((migrationName) => !expectedByName.has(migrationName))
    .sort();
  const checksumMismatches = [...appliedByName.values()]
    .filter((row) => {
      const expectedChecksum = expectedByName.get(row.migration_name);
      return expectedChecksum !== undefined && expectedChecksum !== row.checksum;
    })
    .map((row) => row.migration_name)
    .sort();
  const duplicateAppliedNames = [...duplicateApplied].sort();
  const ok =
    localOnly.length === 0 &&
    databaseOnly.length === 0 &&
    checksumMismatches.length === 0 &&
    incomplete.length === 0 &&
    duplicateAppliedNames.length === 0 &&
    appliedByName.size === expected.length;

  return {
    expectedCount: expected.length,
    appliedCount: appliedByName.size,
    localOnly,
    databaseOnly,
    checksumMismatches,
    incomplete,
    duplicateApplied: duplicateAppliedNames,
    schemaPostconditionsChecked: false,
    schemaPostconditionFailures: [],
    ok,
  };
}

const EXPECTED_ACCOUNT_DELETION_TABLES = [
  "account_deletion_blob_receipts",
  "account_deletions",
  "erased_dreamcoin_ledger_entries",
] as const;

const EXPECTED_ACCOUNT_DELETION_COLUMNS = [
  "account_deletion_blob_receipts.attempts",
  "account_deletion_blob_receipts.createdAt",
  "account_deletion_blob_receipts.deletedAt",
  "account_deletion_blob_receipts.deletionId",
  "account_deletion_blob_receipts.id",
  "account_deletion_blob_receipts.lastError",
  "account_deletion_blob_receipts.leaseExpiresAt",
  "account_deletion_blob_receipts.leaseOwner",
  "account_deletion_blob_receipts.nextAttemptAt",
  "account_deletion_blob_receipts.status",
  "account_deletion_blob_receipts.storageKey",
  "account_deletion_blob_receipts.storageKeyHash",
  "account_deletion_blob_receipts.updatedAt",
  "account_deletions.blobDeletedCount",
  "account_deletions.blobExpectedCount",
  "account_deletions.chatCompletedAt",
  "account_deletions.chatCompletionEventId",
  "account_deletions.chatFileMutationId",
  "account_deletions.chatRequestEventId",
  "account_deletions.completedAt",
  "account_deletions.createdAt",
  "account_deletions.graceEndsAt",
  "account_deletions.id",
  "account_deletions.lastError",
  "account_deletions.mainPurgedAt",
  "account_deletions.requestedAt",
  "account_deletions.status",
  "account_deletions.subjectHash",
  "account_deletions.updatedAt",
  "account_deletions.userId",
  "account_deletions.version",
  "erased_dreamcoin_ledger_entries.archivedAt",
  "erased_dreamcoin_ledger_entries.balanceAfter",
  "erased_dreamcoin_ledger_entries.deletionId",
  "erased_dreamcoin_ledger_entries.delta",
  "erased_dreamcoin_ledger_entries.id",
  "erased_dreamcoin_ledger_entries.occurredAt",
  "erased_dreamcoin_ledger_entries.reason",
  "erased_dreamcoin_ledger_entries.sourceEntryHash",
  "erased_dreamcoin_ledger_entries.sourceIdHash",
] as const;

const EXPECTED_ACCOUNT_DELETION_CONSTRAINTS = [
  "account_deletion_blob_receipts_deletionId_fkey",
  "account_deletion_blob_receipts_pkey",
  "account_deletion_blob_receipts_status_check",
  "account_deletion_blob_receipts_terminal_check",
  "account_deletions_blob_count_check",
  "account_deletions_chat_request_check",
  "account_deletions_chat_terminal_check",
  "account_deletions_grace_period_check",
  "account_deletions_pkey",
  "account_deletions_status_check",
  "account_deletions_terminal_check",
  "erased_dreamcoin_ledger_entries_deletionId_fkey",
  "erased_dreamcoin_ledger_entries_pkey",
] as const;

const EXPECTED_ACCOUNT_DELETION_INDEXES = [
  "account_deletion_blob_receipts_deletionId_storageKeyHash_key",
  // PostgreSQL truncates identifiers to 63 bytes in the live catalog.
  "account_deletion_blob_receipts_status_nextAttemptAt_leaseExpire",
  "account_deletions_chatCompletionEventId_key",
  "account_deletions_chatRequestEventId_key",
  "account_deletions_status_updatedAt_idx",
  "account_deletions_subjectHash_key",
  "account_deletions_userId_key",
  "erased_dreamcoin_ledger_entries_deletionId_sourceEntryHash_key",
  "erased_dreamcoin_ledger_entries_reason_occurredAt_idx",
] as const;

const POSTGRES_CATALOG_FINGERPRINT_MAJOR = 16;
const EXPECTED_VOICE_CONSTRAINT_FINGERPRINT =
  "0652210ea38b19474b5d4da43293773ea812faeb039ae41a7b6d35c03e1a895c";
const EXPECTED_ACCOUNT_DELETION_CHECK_FINGERPRINTS = {
  account_deletion_blob_receipts_status_check:
    "7f50513a510a0cf078e7ec201c145c40f83f6b42b62e4464fa6d42241ee0e6b4",
  account_deletion_blob_receipts_terminal_check:
    "f85e52532e42aca0aead2351bf2370e0efaaff5d2bd8db750ddd749539aebaba",
  account_deletions_blob_count_check:
    "24e04715b1b61fba2568fa5937bd06372fe8c0f0d1cc7c2d7da6022dd114d27a",
  account_deletions_chat_request_check:
    "8a5b2eba58e3cfba839f38cbf11b2ccfb201979b7ceef6e2437fd7631c957d61",
  account_deletions_chat_terminal_check:
    "48bbc84e163c34b0f89618904144bef9d1519566e747df28caf7adfac01d9379",
  account_deletions_grace_period_check:
    "d7e4f55885f647c8fdba51e6503faf3838da4f382ffca35935540f288d03fd4b",
  account_deletions_status_check:
    "63498526e8e843b78cf3a03e81d5116b42e1d041766ff9546a68b11225e38d12",
  account_deletions_terminal_check:
    "ea1bc438a4aed614fc331c2589072665b69f6958ed4cbf573ef74aabe496ebfe",
} as const;
const EXPECTED_ACCOUNT_DELETION_TRIGGER_FUNCTION_FINGERPRINT =
  "e4f7a63d5acb4d5a7cf9c5fdd6cc9e1f75b5b7f67571536dbca13be99c9541e4";

function sameSortedValues(
  actual: readonly string[],
  expected: readonly string[],
) {
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    [...actual]
      .sort()
      .every((value, index) => value === sortedExpected[index])
  );
}

// SPEC: once migration history is exact, launch readiness also proves that the
// mutable PostgreSQL catalog/data still has the terminal shape established by
// the four launch-critical migrations. Migration names alone are insufficient
// because later manual DDL can silently drift a constraint, index, or trigger.
export function evaluateMigrationPostconditions(
  snapshot: MigrationPostconditionSnapshot,
): string[] {
  if (snapshot.postgresMajor !== POSTGRES_CATALOG_FINGERPRINT_MAJOR) {
    return [
      "postgres-catalog: launch migration fingerprints require PostgreSQL 16",
    ];
  }
  const failures: string[] = [];
  const premium = snapshot.premium;
  const premiumShapeIsExact =
    (premium.totalCount === 0 &&
      premium.legacyIdCount === 0 &&
      premium.replacementIdCount === 0) ||
    (premium.totalCount === 1 &&
      premium.activeCount === 1 &&
      premium.versionOneCount === 1 &&
      premium.versionTwoCount === 0 &&
      premium.legacyIdCount === 1 &&
      premium.replacementIdCount === 0 &&
      premium.freshCanonicalCount === 1) ||
    (premium.totalCount === 2 &&
      premium.activeCount === 1 &&
      premium.versionOneCount === 1 &&
      premium.versionTwoCount === 1 &&
      premium.legacyIdCount === 1 &&
      premium.replacementIdCount === 1 &&
      premium.legacyArchivedCount === 1 &&
      premium.replacementCount === 1);
  if (!premiumShapeIsExact) {
    failures.push("redmix3-premium: terminal profile shape drifted");
  }

  if (snapshot.runtime.retiredRunnerCount !== 0) {
    failures.push("runtime-schema: retired runner sd_cpp remains");
  }
  if (snapshot.runtime.retiredArtifactStateCount !== 0) {
    failures.push("runtime-schema: retired artifact state late_after_cancel remains");
  }
  if (snapshot.runtime.profileShadowColumnCount !== 0) {
    failures.push(
      "runtime-schema: character_visual_profiles.referenceAssetIds remains",
    );
  }
  if (snapshot.runtime.runnerDefault !== "'comfyui'::text") {
    failures.push("runtime-schema: generation_model_profiles.runner default drifted");
  }

  if (
    snapshot.voice.constraintCount !== 1 ||
    snapshot.voice.validated !== true ||
    snapshot.voice.definitionFingerprint !==
      EXPECTED_VOICE_CONSTRAINT_FINGERPRINT
  ) {
    failures.push("voice-scene-payload: exact validated constraint drifted");
  }

  const account = snapshot.accountDeletion;
  if (!sameSortedValues(account.columns, EXPECTED_ACCOUNT_DELETION_COLUMNS)) {
    failures.push("account-deletion: required columns drifted");
  }
  for (const column of account.invalidColumns) {
    failures.push(`account-deletion: column ${column} is not authoritative`);
  }
  if (!sameSortedValues(account.tables, EXPECTED_ACCOUNT_DELETION_TABLES)) {
    failures.push("account-deletion: required tables drifted");
  }
  if (
    !sameSortedValues(
      account.constraints,
      EXPECTED_ACCOUNT_DELETION_CONSTRAINTS,
    )
  ) {
    failures.push("account-deletion: required constraints drifted");
  }
  for (const constraint of account.invalidConstraints) {
    failures.push(`account-deletion: constraint ${constraint} is not authoritative`);
  }
  if (
    !sameFingerprintMap(
      account.constraintFingerprints,
      EXPECTED_ACCOUNT_DELETION_CHECK_FINGERPRINTS,
    )
  ) {
    failures.push(
      "account-deletion: exact CHECK constraint fingerprints drifted",
    );
  }
  if (!sameSortedValues(account.indexes, EXPECTED_ACCOUNT_DELETION_INDEXES)) {
    failures.push("account-deletion: required indexes drifted");
  }
  for (const index of account.invalidIndexes) {
    failures.push(`account-deletion: index ${index} is not usable`);
  }
  if (
    account.triggerCount !== 1 ||
    account.triggerIsConstraint !== true ||
    account.triggerDeferrable !== true ||
    account.triggerInitiallyDeferred !== true ||
    account.triggerEnabled !== "O" ||
    account.triggerType !== 21 ||
    account.triggerHasWhenClause !== false ||
    account.triggerHasColumnFilter !== false ||
    account.triggerFunction !== "enforce_customer_account_deletion_authority" ||
    account.triggerFunctionFingerprint !==
      EXPECTED_ACCOUNT_DELETION_TRIGGER_FUNCTION_FINGERPRINT
  ) {
    failures.push("account-deletion: terminal trigger authority drifted");
  }
  return failures;
}

function sameFingerprintMap(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
) {
  const expectedEntries = Object.entries(expected);
  return (
    Object.keys(actual).length === expectedEntries.length &&
    expectedEntries.every(([name, fingerprint]) => actual[name] === fingerprint)
  );
}

const migrationPostconditionSnapshotSql = `
WITH premium AS (
  SELECT
    count(*)::int AS "totalCount",
    count(*) FILTER (WHERE "status" = 'active')::int AS "activeCount",
    count(*) FILTER (WHERE "version" = 1)::int AS "versionOneCount",
    count(*) FILTER (WHERE "version" = 2)::int AS "versionTwoCount",
    count(*) FILTER (WHERE "id" = 'seed-profile-image-premium-v1')::int AS "legacyIdCount",
    count(*) FILTER (WHERE "id" = 'seed-profile-image-premium-v2')::int AS "replacementIdCount",
    count(*) FILTER (WHERE
      "id" = 'seed-profile-image-premium-v1'
      AND "version" = 1
      AND "mode" = 'image'
      AND "status" = 'active'
      AND "publishedAt" IS NOT NULL
      AND "archivedAt" IS NULL
      AND "enabled" = true
      AND "rolloutPercent" = 100
      AND "requiredEntitlement" = 'premium_models'
      AND "runner" = 'comfyui'
      AND "pipelineModel" = 'redcraft-krea2-redmix3-fp8'
      AND "workflowKey" = 'redcraft-krea2-redmix3-txt2img'
      AND "sourceModelPath" IS NOT NULL
      AND "modelFormat" = 'safetensors'
      AND "runnerConfig" IS NOT NULL
      AND "runnerConfig" ->> 'apiModelId' = 'redcraft-krea2-redmix3-fp8'
      AND ("runnerConfig" ->> 'modelPath' = "sourceModelPath"
        OR "runnerConfig" ->> 'diffusionModelPath' = "sourceModelPath")
      AND "runnerConfig" #>> '{capabilities,textToImage}' = 'true'
      AND ("runnerConfig" ->> 'workflowPath' = 'redcraft-krea2-redmix3-txt2img.json'
        OR "runnerConfig" ->> 'workflowPath' LIKE '%/redcraft-krea2-redmix3-txt2img.json')
    )::int AS "freshCanonicalCount",
    count(*) FILTER (WHERE
      "id" = 'seed-profile-image-premium-v1'
      AND "version" = 1
      AND "mode" = 'image'
      AND "runner" = 'comfyui'
      AND "pipelineModel" = 'redcraft-krea2-comfyui'
      AND "workflowKey" = 'redcraft-krea2-txt2img'
      AND "status" = 'archived'
      AND "archivedAt" IS NOT NULL
      AND "enabled" = true
      AND "rolloutPercent" = 100
      AND "requiredEntitlement" = 'premium_models'
    )::int AS "legacyArchivedCount",
    count(*) FILTER (WHERE
      "id" = 'seed-profile-image-premium-v2'
      AND "version" = 2
      AND "mode" = 'image'
      AND "status" = 'active'
      AND "publishedAt" IS NOT NULL
      AND "archivedAt" IS NULL
      AND "enabled" = true
      AND "rolloutPercent" = 100
      AND "requiredEntitlement" = 'premium_models'
      AND "runner" = 'comfyui'
      AND "pipelineModel" = 'redcraft-krea2-redmix3-fp8'
      AND "workflowKey" = 'redcraft-krea2-redmix3-txt2img'
      AND "sourceModelPath" IS NOT NULL
      AND "modelFormat" = 'safetensors'
      AND "runnerConfig" IS NOT NULL
      AND "runnerConfig" ->> 'apiModelId' = 'redcraft-krea2-redmix3-fp8'
      AND ("runnerConfig" ->> 'modelPath' = "sourceModelPath"
        OR "runnerConfig" ->> 'diffusionModelPath' = "sourceModelPath")
      AND "runnerConfig" #>> '{capabilities,textToImage}' = 'true'
      AND ("runnerConfig" ->> 'workflowPath' = 'redcraft-krea2-redmix3-txt2img.json'
        OR "runnerConfig" ->> 'workflowPath' LIKE '%/redcraft-krea2-redmix3-txt2img.json')
    )::int AS "replacementCount"
  FROM public.generation_model_profiles
  WHERE "profileKey" = 'profile_image_premium_v1'
), account_tables AS (
  SELECT coalesce(jsonb_agg(c.relname ORDER BY c.relname), '[]'::jsonb) AS names
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND c.relname = ANY (ARRAY[
      'account_deletions',
      'account_deletion_blob_receipts',
      'erased_dreamcoin_ledger_entries'
    ])
), expected_account_columns(table_name, column_name, expected_type, expected_not_null, expected_default) AS (
  VALUES
    ('account_deletions', 'id', 'text', true, NULL),
    ('account_deletions', 'userId', 'text', false, NULL),
    ('account_deletions', 'subjectHash', 'text', true, NULL),
    ('account_deletions', 'status', 'text', true, '''awaiting_chat''::text'),
    ('account_deletions', 'requestedAt', 'timestamp(3) without time zone', true, 'CURRENT_TIMESTAMP'),
    ('account_deletions', 'graceEndsAt', 'timestamp(3) without time zone', true, NULL),
    ('account_deletions', 'chatRequestEventId', 'text', false, NULL),
    ('account_deletions', 'chatCompletionEventId', 'text', false, NULL),
    ('account_deletions', 'chatFileMutationId', 'text', false, NULL),
    ('account_deletions', 'chatCompletedAt', 'timestamp(3) without time zone', false, NULL),
    ('account_deletions', 'blobExpectedCount', 'integer', true, '0'),
    ('account_deletions', 'blobDeletedCount', 'integer', true, '0'),
    ('account_deletions', 'mainPurgedAt', 'timestamp(3) without time zone', false, NULL),
    ('account_deletions', 'completedAt', 'timestamp(3) without time zone', false, NULL),
    ('account_deletions', 'lastError', 'jsonb', false, NULL),
    ('account_deletions', 'version', 'integer', true, '1'),
    ('account_deletions', 'createdAt', 'timestamp(3) without time zone', true, 'CURRENT_TIMESTAMP'),
    ('account_deletions', 'updatedAt', 'timestamp(3) without time zone', true, NULL),
    ('account_deletion_blob_receipts', 'id', 'text', true, NULL),
    ('account_deletion_blob_receipts', 'deletionId', 'text', true, NULL),
    ('account_deletion_blob_receipts', 'storageKey', 'text', false, NULL),
    ('account_deletion_blob_receipts', 'storageKeyHash', 'text', true, NULL),
    ('account_deletion_blob_receipts', 'status', 'text', true, '''pending''::text'),
    ('account_deletion_blob_receipts', 'attempts', 'integer', true, '0'),
    ('account_deletion_blob_receipts', 'nextAttemptAt', 'timestamp(3) without time zone', true, 'CURRENT_TIMESTAMP'),
    ('account_deletion_blob_receipts', 'leaseOwner', 'text', false, NULL),
    ('account_deletion_blob_receipts', 'leaseExpiresAt', 'timestamp(3) without time zone', false, NULL),
    ('account_deletion_blob_receipts', 'lastError', 'jsonb', false, NULL),
    ('account_deletion_blob_receipts', 'deletedAt', 'timestamp(3) without time zone', false, NULL),
    ('account_deletion_blob_receipts', 'createdAt', 'timestamp(3) without time zone', true, 'CURRENT_TIMESTAMP'),
    ('account_deletion_blob_receipts', 'updatedAt', 'timestamp(3) without time zone', true, NULL),
    ('erased_dreamcoin_ledger_entries', 'id', 'text', true, NULL),
    ('erased_dreamcoin_ledger_entries', 'deletionId', 'text', true, NULL),
    ('erased_dreamcoin_ledger_entries', 'sourceEntryHash', 'text', true, NULL),
    ('erased_dreamcoin_ledger_entries', 'sourceIdHash', 'text', false, NULL),
    ('erased_dreamcoin_ledger_entries', 'delta', 'integer', true, NULL),
    ('erased_dreamcoin_ledger_entries', 'balanceAfter', 'integer', true, NULL),
    ('erased_dreamcoin_ledger_entries', 'reason', 'text', true, NULL),
    ('erased_dreamcoin_ledger_entries', 'occurredAt', 'timestamp(3) without time zone', true, NULL),
    ('erased_dreamcoin_ledger_entries', 'archivedAt', 'timestamp(3) without time zone', true, 'CURRENT_TIMESTAMP')
), account_columns AS (
  SELECT
    coalesce(jsonb_agg(e.table_name || '.' || e.column_name ORDER BY e.table_name, e.column_name), '[]'::jsonb) AS names,
    coalesce(jsonb_agg(e.table_name || '.' || e.column_name ORDER BY e.table_name, e.column_name) FILTER (WHERE
      format_type(a.atttypid, a.atttypmod) IS DISTINCT FROM e.expected_type
      OR a.attnotnull IS DISTINCT FROM e.expected_not_null
      OR pg_get_expr(d.adbin, d.adrelid) IS DISTINCT FROM e.expected_default
    ), '[]'::jsonb) AS invalid
  FROM expected_account_columns e
  JOIN pg_namespace n ON n.nspname = 'public'
  JOIN pg_class r ON r.relnamespace = n.oid AND r.relname = e.table_name
  JOIN pg_attribute a ON a.attrelid = r.oid AND a.attname = e.column_name
    AND a.attnum > 0 AND NOT a.attisdropped
  LEFT JOIN pg_attrdef d ON d.adrelid = r.oid AND d.adnum = a.attnum
), expected_constraints(name, table_name, constraint_type, expected_columns, reference_table, expected_fingerprint) AS (
  VALUES
    ('account_deletions_pkey', 'account_deletions', 'p', ARRAY['id']::text[], NULL, NULL),
    ('account_deletions_status_check', 'account_deletions', 'c', NULL, NULL, '63498526e8e843b78cf3a03e81d5116b42e1d041766ff9546a68b11225e38d12'),
    ('account_deletions_grace_period_check', 'account_deletions', 'c', NULL, NULL, 'd7e4f55885f647c8fdba51e6503faf3838da4f382ffca35935540f288d03fd4b'),
    ('account_deletions_chat_terminal_check', 'account_deletions', 'c', NULL, NULL, '48bbc84e163c34b0f89618904144bef9d1519566e747df28caf7adfac01d9379'),
    ('account_deletions_chat_request_check', 'account_deletions', 'c', NULL, NULL, '8a5b2eba58e3cfba839f38cbf11b2ccfb201979b7ceef6e2437fd7631c957d61'),
    ('account_deletions_terminal_check', 'account_deletions', 'c', NULL, NULL, 'ea1bc438a4aed614fc331c2589072665b69f6958ed4cbf573ef74aabe496ebfe'),
    ('account_deletions_blob_count_check', 'account_deletions', 'c', NULL, NULL, '24e04715b1b61fba2568fa5937bd06372fe8c0f0d1cc7c2d7da6022dd114d27a'),
    ('account_deletion_blob_receipts_pkey', 'account_deletion_blob_receipts', 'p', ARRAY['id']::text[], NULL, NULL),
    ('account_deletion_blob_receipts_status_check', 'account_deletion_blob_receipts', 'c', NULL, NULL, '7f50513a510a0cf078e7ec201c145c40f83f6b42b62e4464fa6d42241ee0e6b4'),
    ('account_deletion_blob_receipts_terminal_check', 'account_deletion_blob_receipts', 'c', NULL, NULL, 'f85e52532e42aca0aead2351bf2370e0efaaff5d2bd8db750ddd749539aebaba'),
    ('account_deletion_blob_receipts_deletionId_fkey', 'account_deletion_blob_receipts', 'f', ARRAY['deletionId']::text[], 'account_deletions', NULL),
    ('erased_dreamcoin_ledger_entries_pkey', 'erased_dreamcoin_ledger_entries', 'p', ARRAY['id']::text[], NULL, NULL),
    ('erased_dreamcoin_ledger_entries_deletionId_fkey', 'erased_dreamcoin_ledger_entries', 'f', ARRAY['deletionId']::text[], 'account_deletions', NULL)
), account_constraints AS (
  SELECT
    coalesce(jsonb_agg(c.conname ORDER BY c.conname), '[]'::jsonb) AS names,
    coalesce(jsonb_object_agg(c.conname, encode(sha256(convert_to(pg_get_constraintdef(c.oid), 'UTF8')), 'hex')) FILTER (WHERE c.contype = 'c'), '{}'::jsonb) AS fingerprints,
    coalesce(jsonb_agg(c.conname ORDER BY c.conname) FILTER (WHERE
      NOT c.convalidated
      OR c.contype::text <> e.constraint_type
      OR (e.expected_columns IS NOT NULL AND ARRAY(
        SELECT a.attname::text
        FROM unnest(c.conkey) WITH ORDINALITY AS key(attnum, position)
        JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum = key.attnum
        ORDER BY key.position
      ) IS DISTINCT FROM e.expected_columns)
      OR (e.reference_table IS NOT NULL AND (
        c.confrelid IS DISTINCT FROM to_regclass('public.' || e.reference_table)
        OR c.confupdtype <> 'c' OR c.confdeltype <> 'c'
        OR ARRAY(
          SELECT a.attname::text
          FROM unnest(c.confkey) WITH ORDINALITY AS key(attnum, position)
          JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = key.attnum
          ORDER BY key.position
        ) IS DISTINCT FROM ARRAY['id']::text[]
      ))
      OR (c.contype = 'c' AND encode(sha256(convert_to(pg_get_constraintdef(c.oid), 'UTF8')), 'hex') IS DISTINCT FROM e.expected_fingerprint)
    ), '[]'::jsonb) AS invalid
  FROM expected_constraints e
  JOIN pg_namespace n ON n.nspname = 'public'
  JOIN pg_class r ON r.relnamespace = n.oid AND r.relname = e.table_name
  JOIN pg_constraint c ON c.conrelid = r.oid AND c.conname = e.name
), expected_indexes(name, table_name, should_be_unique, expected_columns) AS (
  VALUES
    ('account_deletions_userId_key', 'account_deletions', true, ARRAY['userId']::text[]),
    ('account_deletions_subjectHash_key', 'account_deletions', true, ARRAY['subjectHash']::text[]),
    ('account_deletions_chatRequestEventId_key', 'account_deletions', true, ARRAY['chatRequestEventId']::text[]),
    ('account_deletions_chatCompletionEventId_key', 'account_deletions', true, ARRAY['chatCompletionEventId']::text[]),
    ('account_deletions_status_updatedAt_idx', 'account_deletions', false, ARRAY['status', 'updatedAt']::text[]),
    ('account_deletion_blob_receipts_deletionId_storageKeyHash_key', 'account_deletion_blob_receipts', true, ARRAY['deletionId', 'storageKeyHash']::text[]),
    ('account_deletion_blob_receipts_status_nextAttemptAt_leaseExpire', 'account_deletion_blob_receipts', false, ARRAY['status', 'nextAttemptAt', 'leaseExpiresAt']::text[]),
    ('erased_dreamcoin_ledger_entries_deletionId_sourceEntryHash_key', 'erased_dreamcoin_ledger_entries', true, ARRAY['deletionId', 'sourceEntryHash']::text[]),
    ('erased_dreamcoin_ledger_entries_reason_occurredAt_idx', 'erased_dreamcoin_ledger_entries', false, ARRAY['reason', 'occurredAt']::text[])
), account_indexes AS (
  SELECT
    coalesce(jsonb_agg(idx.relname ORDER BY idx.relname), '[]'::jsonb) AS names,
    coalesce(jsonb_agg(idx.relname ORDER BY idx.relname) FILTER (WHERE
      NOT i.indisvalid OR NOT i.indisready OR NOT i.indislive
      OR i.indisunique IS DISTINCT FROM e.should_be_unique
      OR i.indnullsnotdistinct
      OR i.indexprs IS NOT NULL OR i.indpred IS NOT NULL
      OR ARRAY(
        SELECT a.attname::text
        FROM unnest(i.indkey) WITH ORDINALITY AS key(attnum, position)
        JOIN pg_attribute a ON a.attrelid = tbl.oid AND a.attnum = key.attnum
        ORDER BY key.position
      ) IS DISTINCT FROM e.expected_columns
    ), '[]'::jsonb) AS invalid
  FROM expected_indexes e
  JOIN pg_namespace n ON n.nspname = 'public'
  JOIN pg_class tbl ON tbl.relnamespace = n.oid AND tbl.relname = e.table_name
  JOIN pg_index i ON i.indrelid = tbl.oid
  JOIN pg_class idx ON idx.oid = i.indexrelid AND idx.relname = e.name
), account_trigger AS (
  SELECT
    count(*)::int AS "triggerCount",
    (array_agg(t.tgconstraint <> 0))[1] AS "triggerIsConstraint",
    (array_agg(c.condeferrable))[1] AS "triggerDeferrable",
    (array_agg(c.condeferred))[1] AS "triggerInitiallyDeferred",
    (array_agg(t.tgenabled::text))[1] AS "triggerEnabled",
    (array_agg(t.tgtype::int))[1] AS "triggerType",
    (array_agg(t.tgqual IS NOT NULL))[1] AS "triggerHasWhenClause",
    (array_agg(t.tgattr::text <> ''))[1] AS "triggerHasColumnFilter",
    (array_agg(p.proname))[1] AS "triggerFunction",
    (array_agg(encode(sha256(convert_to(pg_get_functiondef(p.oid), 'UTF8')), 'hex')))[1] AS "triggerFunctionFingerprint"
  FROM pg_trigger t
  JOIN pg_class r ON r.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = r.relnamespace
  LEFT JOIN pg_constraint c ON c.oid = t.tgconstraint
  JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE n.nspname = 'public'
    AND r.relname = 'users'
    AND t.tgname = 'customer_account_deletion_authority_required'
)
SELECT
  (current_setting('server_version_num')::int / 10000)::int AS "postgresMajor",
  to_jsonb(premium) AS premium,
  jsonb_build_object(
    'retiredRunnerCount', (SELECT count(*)::int FROM public.generation_model_profiles WHERE runner = 'sd_cpp'),
    'retiredArtifactStateCount', (SELECT count(*)::int FROM public.generation_artifacts WHERE "validationState" = 'late_after_cancel'),
    'profileShadowColumnCount', (SELECT count(*)::int FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'character_visual_profiles' AND column_name = 'referenceAssetIds'),
    'runnerDefault', (SELECT column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'generation_model_profiles' AND column_name = 'runner')
  ) AS runtime,
  jsonb_build_object(
    'constraintCount', (SELECT count(*)::int FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname = 'public' AND r.relname = 'voice_clip_requests' AND c.conname = 'voice_clip_requests_synthesis_payload_check' AND c.contype = 'c'),
    'validated', (SELECT c.convalidated FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname = 'public' AND r.relname = 'voice_clip_requests' AND c.conname = 'voice_clip_requests_synthesis_payload_check' AND c.contype = 'c' LIMIT 1),
    'definitionFingerprint', (SELECT encode(sha256(convert_to(pg_get_constraintdef(c.oid), 'UTF8')), 'hex') FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname = 'public' AND r.relname = 'voice_clip_requests' AND c.conname = 'voice_clip_requests_synthesis_payload_check' AND c.contype = 'c' LIMIT 1)
  ) AS voice,
  jsonb_build_object(
    'columns', account_columns.names,
    'invalidColumns', account_columns.invalid,
    'tables', account_tables.names,
    'constraints', account_constraints.names,
    'invalidConstraints', account_constraints.invalid,
    'constraintFingerprints', account_constraints.fingerprints,
    'indexes', account_indexes.names,
    'invalidIndexes', account_indexes.invalid,
    'triggerCount', account_trigger."triggerCount",
    'triggerIsConstraint', account_trigger."triggerIsConstraint",
    'triggerDeferrable', account_trigger."triggerDeferrable",
    'triggerInitiallyDeferred', account_trigger."triggerInitiallyDeferred",
    'triggerEnabled', account_trigger."triggerEnabled",
    'triggerType', account_trigger."triggerType",
    'triggerHasWhenClause', account_trigger."triggerHasWhenClause",
    'triggerHasColumnFilter', account_trigger."triggerHasColumnFilter",
    'triggerFunction', account_trigger."triggerFunction",
    'triggerFunctionFingerprint', account_trigger."triggerFunctionFingerprint"
  ) AS "accountDeletion"
FROM premium, account_tables, account_columns, account_constraints, account_indexes, account_trigger
`;

export async function inspectMigrationAuthorityWithDatabase(
  db: MigrationAuthorityDatabase,
  expected: readonly ExpectedMigration[],
): Promise<MigrationAuthority> {
  const result = await db.query<DatabaseMigration>(
    `SELECT migration_name, checksum, finished_at, rolled_back_at
       FROM _prisma_migrations
      ORDER BY migration_name, started_at`,
  );
  const history = evaluateMigrationAuthority(result.rows, expected);
  if (!history.ok) return history;

  // INVARIANT: the exact catalog query below is PostgreSQL 16-specific. Read
  // the portable server version first so older clusters fail closed with an
  // actionable authority result instead of crashing on a missing catalog
  // column before the launch gate can explain the mismatch.
  const versionResult = await db.query<PostgreSqlVersionSnapshot>(
    `SELECT (current_setting('server_version_num')::int / 10000)::int AS "postgresMajor"`,
  );
  const postgresMajor = versionResult.rows[0]?.postgresMajor;
  if (postgresMajor !== POSTGRES_CATALOG_FINGERPRINT_MAJOR) {
    return {
      ...history,
      schemaPostconditionsChecked: true,
      schemaPostconditionFailures: [
        "postgres-catalog: launch migration fingerprints require PostgreSQL 16",
      ],
      ok: false,
    };
  }

  const postconditionResult = await db.query<MigrationPostconditionSnapshot>(
    migrationPostconditionSnapshotSql,
  );
  const snapshot = postconditionResult.rows[0];
  if (!snapshot) {
    throw new Error("migration schema postcondition query returned no snapshot");
  }
  const schemaPostconditionFailures = evaluateMigrationPostconditions(snapshot);
  return {
    ...history,
    schemaPostconditionsChecked: true,
    schemaPostconditionFailures,
    ok: schemaPostconditionFailures.length === 0,
  };
}

export async function loadExpectedMigrationAuthority(
  migrationsDirectory = defaultMigrationsDirectory,
): Promise<ExpectedMigration[]> {
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return Promise.all(
    names.map(async (migrationName) => {
      const sql = await readFile(
        path.join(migrationsDirectory, migrationName, "migration.sql"),
      );
      return {
        migrationName,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
}

export async function inspectMigrationAuthority(
  connectionString: string,
): Promise<MigrationAuthority> {
  const expected = await loadExpectedMigrationAuthority();
  const db = new Client({ connectionString });
  await db.connect();
  try {
    // INVARIANT: the two authority queries must finish before the client closes.
    // Returning the unresolved promise lets `finally` terminate the connection.
    return await inspectMigrationAuthorityWithDatabase(db, expected);
  } finally {
    await db.end();
  }
}
