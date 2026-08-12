import { describe, expect, it } from "vitest";
import {
  evaluateMigrationAuthority,
  evaluateMigrationPostconditions,
  inspectMigrationAuthorityWithDatabase,
  type DatabaseMigration,
  type ExpectedMigration,
  type MigrationPostconditionSnapshot,
} from "./migration-authority";

const expected: ExpectedMigration[] = [
  { migrationName: "001_base", checksum: "a".repeat(64) },
  { migrationName: "002_runtime", checksum: "b".repeat(64) },
];

function applied(
  migrationName: string,
  checksum: string,
): DatabaseMigration {
  return {
    migration_name: migrationName,
    checksum,
    finished_at: "2026-08-11T00:00:00.000Z",
    rolled_back_at: null,
  };
}

describe("migration readiness authority", () => {
  it("passes only an exact applied-name and checksum match", () => {
    expect(
      evaluateMigrationAuthority(
        [applied("001_base", "a".repeat(64)), applied("002_runtime", "b".repeat(64))],
        expected,
      ),
    ).toMatchObject({
      ok: true,
      expectedCount: 2,
      appliedCount: 2,
      localOnly: [],
      databaseOnly: [],
      checksumMismatches: [],
      incomplete: [],
      duplicateApplied: [],
    });
  });

  it("fails closed for pending, database-only, edited, and unfinished migrations", () => {
    const authority = evaluateMigrationAuthority(
      [
        applied("001_base", "c".repeat(64)),
        applied("003_database_only", "d".repeat(64)),
        {
          migration_name: "004_failed",
          checksum: "e".repeat(64),
          finished_at: null,
          rolled_back_at: null,
        },
      ],
      expected,
    );

    expect(authority).toMatchObject({
      ok: false,
      localOnly: ["002_runtime"],
      databaseOnly: ["003_database_only"],
      checksumMismatches: ["001_base"],
      incomplete: ["004_failed"],
    });
  });

  it("does not count rolled-back rows as applied authority", () => {
    const authority = evaluateMigrationAuthority(
      [
        applied("001_base", "a".repeat(64)),
        {
          migration_name: "002_runtime",
          checksum: "b".repeat(64),
          finished_at: "2026-08-11T00:00:00.000Z",
          rolled_back_at: "2026-08-11T00:01:00.000Z",
        },
      ],
      expected,
    );

    expect(authority.ok).toBe(false);
    expect(authority.localOnly).toEqual(["002_runtime"]);
    expect(authority.appliedCount).toBe(1);
  });

  it("does not inspect unapplied schema postconditions while migrations are pending", async () => {
    const queries: string[] = [];
    const authority = await inspectMigrationAuthorityWithDatabase(
      {
        query: async <T>(sql: string) => {
          queries.push(sql);
          return {
            rows: [applied("001_base", "a".repeat(64))] as T[],
          };
        },
      },
      expected,
    );

    expect(authority).toMatchObject({
      ok: false,
      localOnly: ["002_runtime"],
      schemaPostconditionsChecked: false,
      schemaPostconditionFailures: [],
    });
    expect(queries).toHaveLength(1);
  });

  it("rejects unsupported PostgreSQL before reading PG16-only catalog columns", async () => {
    const rows = [
      applied("001_base", "a".repeat(64)),
      applied("002_runtime", "b".repeat(64)),
    ];
    const queries: string[] = [];
    const authority = await inspectMigrationAuthorityWithDatabase(
      {
        query: async <T>(sql: string) => {
          queries.push(sql);
          if (queries.length === 1) return { rows: rows as T[] };
          if (queries.length === 2) {
            return { rows: [{ postgresMajor: 14 }] as T[] };
          }
          throw new Error("PG16 catalog snapshot must not run on PostgreSQL 14");
        },
      },
      expected,
    );

    expect(authority).toMatchObject({
      ok: false,
      schemaPostconditionsChecked: true,
      schemaPostconditionFailures: [
        "postgres-catalog: launch migration fingerprints require PostgreSQL 16",
      ],
    });
    expect(queries).toHaveLength(2);
    expect(queries[1]).toContain("server_version_num");
    expect(queries[1]).not.toContain("indnullsnotdistinct");
  });

  it("fails a complete migration history when current schema postconditions drift", async () => {
    const rows = [
      applied("001_base", "a".repeat(64)),
      applied("002_runtime", "b".repeat(64)),
    ];
    const drifted = exactPostconditionSnapshot({
      runtime: {
        retiredRunnerCount: 1,
        retiredArtifactStateCount: 0,
        profileShadowColumnCount: 0,
        runnerDefault: "'comfyui'::text",
      },
    });
    let queryIndex = 0;
    const queries: string[] = [];
    const authority = await inspectMigrationAuthorityWithDatabase(
      {
        query: async <T>(sql: string) => {
          queryIndex += 1;
          queries.push(sql);
          return {
            rows: (queryIndex === 1
              ? rows
              : queryIndex === 2
                ? [{ postgresMajor: 16 }]
                : [drifted]) as T[],
          };
        },
      },
      expected,
    );

    expect(authority).toMatchObject({
      ok: false,
      schemaPostconditionsChecked: true,
      schemaPostconditionFailures: [
        "runtime-schema: retired runner sd_cpp remains",
      ],
    });
    expect(queries[2]).toContain("pg_get_constraintdef(c.oid)");
    expect(queries[2]).not.toContain("lower(pg_get_constraintdef");
    expect(queries[2]).not.toContain("regexp_replace");
    expect(queries[2]).toContain("i.indnullsnotdistinct");
    expect(queries[2]).toContain("t.tgattr::text <> ''");
    expect(queries[2]).toContain("format_type(a.atttypid, a.atttypmod)");
    expect(queries[2]).toContain("a.attnotnull");
    expect(queries[2]).toContain("pg_get_expr(d.adbin, d.adrelid)");
  });
});

function exactPostconditionSnapshot(
  overrides: Partial<MigrationPostconditionSnapshot> = {},
): MigrationPostconditionSnapshot {
  return {
    postgresMajor: 16,
    premium: {
      totalCount: 2,
      activeCount: 1,
      versionOneCount: 1,
      versionTwoCount: 1,
      legacyIdCount: 1,
      replacementIdCount: 1,
      freshCanonicalCount: 0,
      legacyArchivedCount: 1,
      replacementCount: 1,
    },
    runtime: {
      retiredRunnerCount: 0,
      retiredArtifactStateCount: 0,
      profileShadowColumnCount: 0,
      runnerDefault: "'comfyui'::text",
    },
    voice: {
      constraintCount: 1,
      validated: true,
      definitionFingerprint:
        "0652210ea38b19474b5d4da43293773ea812faeb039ae41a7b6d35c03e1a895c",
    },
    accountDeletion: {
      columns: [
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
      ],
      invalidColumns: [],
      tables: [
        "account_deletion_blob_receipts",
        "account_deletions",
        "erased_dreamcoin_ledger_entries",
      ],
      constraints: [
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
      ],
      invalidConstraints: [],
      constraintFingerprints: {
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
      },
      indexes: [
        "account_deletion_blob_receipts_deletionId_storageKeyHash_key",
        "account_deletion_blob_receipts_status_nextAttemptAt_leaseExpire",
        "account_deletions_chatCompletionEventId_key",
        "account_deletions_chatRequestEventId_key",
        "account_deletions_status_updatedAt_idx",
        "account_deletions_subjectHash_key",
        "account_deletions_userId_key",
        "erased_dreamcoin_ledger_entries_deletionId_sourceEntryHash_key",
        "erased_dreamcoin_ledger_entries_reason_occurredAt_idx",
      ],
      invalidIndexes: [],
      triggerCount: 1,
      triggerIsConstraint: true,
      triggerDeferrable: true,
      triggerInitiallyDeferred: true,
      triggerEnabled: "O",
      triggerType: 21,
      triggerHasWhenClause: false,
      triggerHasColumnFilter: false,
      triggerFunction: "enforce_customer_account_deletion_authority",
      triggerFunctionFingerprint:
        "e4f7a63d5acb4d5a7cf9c5fdd6cc9e1f75b5b7f67571536dbca13be99c9541e4",
    },
    ...overrides,
  };
}

describe("migration schema postconditions", () => {
  it("accepts the exact four-migration terminal shape", () => {
    expect(evaluateMigrationPostconditions(exactPostconditionSnapshot())).toEqual(
      [],
    );
  });

  it("rejects a flattened Voice constraint even when every keyword remains", () => {
    const exact = exactPostconditionSnapshot();
    expect(evaluateMigrationPostconditions(exactPostconditionSnapshot({
      voice: { ...exact.voice, definitionFingerprint: "flattened-voice-hash" },
    }))).toContain("voice-scene-payload: exact validated constraint drifted");
  });

  it("rejects AccountDeletion NOT IN and OR-to-AND semantic rewrites", () => {
    const exact = exactPostconditionSnapshot();
    const notIn = {
      ...exact.accountDeletion.constraintFingerprints,
      account_deletions_status_check: "not-in-rewrite-hash",
    };
    const orToAnd = {
      ...exact.accountDeletion.constraintFingerprints,
      account_deletions_terminal_check: "or-to-and-rewrite-hash",
    };

    expect(evaluateMigrationPostconditions(exactPostconditionSnapshot({
      accountDeletion: {
        ...exact.accountDeletion,
        constraintFingerprints: notIn,
      },
    }))).toContain("account-deletion: exact CHECK constraint fingerprints drifted");
    expect(evaluateMigrationPostconditions(exactPostconditionSnapshot({
      accountDeletion: {
        ...exact.accountDeletion,
        constraintFingerprints: orToAnd,
      },
    }))).toContain("account-deletion: exact CHECK constraint fingerprints drifted");
  });

  it("rejects AccountDeletion column type, nullability, or default drift", () => {
    const exact = exactPostconditionSnapshot();
    expect(
      evaluateMigrationPostconditions(
        exactPostconditionSnapshot({
          accountDeletion: {
            ...exact.accountDeletion,
            invalidColumns: [
              "account_deletions.status",
              "account_deletions.requestedAt",
              "erased_dreamcoin_ledger_entries.balanceAfter",
            ],
          },
        }),
      ),
    ).toEqual([
      "account-deletion: column account_deletions.status is not authoritative",
      "account-deletion: column account_deletions.requestedAt is not authoritative",
      "account-deletion: column erased_dreamcoin_ledger_entries.balanceAfter is not authoritative",
    ]);
  });

  it("fails closed outside PostgreSQL 16 catalog authority", () => {
    expect(evaluateMigrationPostconditions(exactPostconditionSnapshot({
      postgresMajor: 17,
    }))).toEqual([
      "postgres-catalog: launch migration fingerprints require PostgreSQL 16",
    ]);
  });

  it("rejects a trigger with missing events or a WHEN qualifier", () => {
    const exact = exactPostconditionSnapshot();
    expect(
      evaluateMigrationPostconditions(
        exactPostconditionSnapshot({
          accountDeletion: {
            ...exact.accountDeletion,
            triggerType: 5,
          },
        }),
      ),
    ).toContain("account-deletion: terminal trigger authority drifted");
    expect(
      evaluateMigrationPostconditions(
        exactPostconditionSnapshot({
          accountDeletion: {
            ...exact.accountDeletion,
            triggerHasWhenClause: true,
          },
        }),
      ),
    ).toContain("account-deletion: terminal trigger authority drifted");
    expect(
      evaluateMigrationPostconditions(
        exactPostconditionSnapshot({
          accountDeletion: {
            ...exact.accountDeletion,
            triggerHasColumnFilter: true,
          },
        }),
      ),
    ).toContain("account-deletion: terminal trigger authority drifted");
  });

  it("reports Premium, Voice, and AccountDeletion catalog drift independently", () => {
    const snapshot = exactPostconditionSnapshot({
      premium: {
        totalCount: 2,
        activeCount: 2,
        versionOneCount: 1,
        versionTwoCount: 1,
        legacyIdCount: 1,
        replacementIdCount: 1,
        freshCanonicalCount: 0,
        legacyArchivedCount: 0,
        replacementCount: 1,
      },
      voice: {
        constraintCount: 1,
        validated: true,
        definitionFingerprint: "check-true-hash",
      },
      accountDeletion: {
        ...exactPostconditionSnapshot().accountDeletion,
        invalidConstraints: ["account_deletions_terminal_check"],
        invalidIndexes: ["account_deletions_userId_key"],
        triggerInitiallyDeferred: false,
      },
    });

    expect(evaluateMigrationPostconditions(snapshot)).toEqual([
      "redmix3-premium: terminal profile shape drifted",
      "voice-scene-payload: exact validated constraint drifted",
      "account-deletion: constraint account_deletions_terminal_check is not authoritative",
      "account-deletion: index account_deletions_userId_key is not usable",
      "account-deletion: terminal trigger authority drifted",
    ]);
  });
});
