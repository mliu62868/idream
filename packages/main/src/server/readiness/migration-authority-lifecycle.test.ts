import { describe, expect, it, vi } from "vitest";

describe("migration authority client lifecycle", () => {
  it("keeps the database client open until schema postconditions settle", async () => {
    vi.resetModules();

    let queryCount = 0;
    let ended = false;
    let migrationRows: unknown[] = [];
    let resolvePostconditions!: (value: { rows: unknown[] }) => void;
    let markPostconditionsStarted!: () => void;
    const postconditionsStarted = new Promise<void>((resolve) => {
      markPostconditionsStarted = resolve;
    });
    const postconditions = new Promise<{ rows: unknown[] }>((resolve) => {
      resolvePostconditions = resolve;
    });

    vi.doMock("pg", () => ({
      Client: class {
        async connect() {}

        async query() {
          queryCount += 1;
          if (queryCount === 1) return { rows: migrationRows };
          if (queryCount === 2) return { rows: [{ postgresMajor: 16 }] };
          markPostconditionsStarted();
          return postconditions;
        }

        async end() {
          ended = true;
        }
      },
    }));

    const authority = await import("./migration-authority");
    const expected = await authority.loadExpectedMigrationAuthority();
    migrationRows = expected.map((migration) => ({
      migration_name: migration.migrationName,
      checksum: migration.checksum,
      finished_at: new Date(),
      rolled_back_at: null,
    }));

    const inspection = authority.inspectMigrationAuthority(
      "postgresql://migration-authority.invalid/test",
    );
    await postconditionsStarted;
    expect(ended).toBe(false);

    resolvePostconditions({
      rows: [
        {
          postgresMajor: 16,
          premium: {
            totalCount: 0,
            activeCount: 0,
            versionOneCount: 0,
            versionTwoCount: 0,
            legacyIdCount: 0,
            replacementIdCount: 0,
            freshCanonicalCount: 0,
            legacyArchivedCount: 0,
            replacementCount: 0,
          },
          runtime: {
            retiredRunnerCount: 0,
            retiredArtifactStateCount: 0,
            profileShadowColumnCount: 0,
            runnerDefault: "'comfyui'::text",
          },
          voice: {
            constraintCount: 0,
            validated: null,
            definitionFingerprint: null,
          },
          accountDeletion: {
            columns: [],
            invalidColumns: [],
            tables: [],
            constraints: [],
            invalidConstraints: [],
            constraintFingerprints: {},
            indexes: [],
            invalidIndexes: [],
            triggerCount: 0,
            triggerIsConstraint: null,
            triggerDeferrable: null,
            triggerInitiallyDeferred: null,
            triggerEnabled: null,
            triggerType: null,
            triggerHasWhenClause: null,
            triggerHasColumnFilter: null,
            triggerFunction: null,
            triggerFunctionFingerprint: null,
          },
        },
      ],
    });

    await inspection;
    expect(ended).toBe(true);
    vi.doUnmock("pg");
  });
});
