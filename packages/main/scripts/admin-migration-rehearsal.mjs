import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const sourceUrl = new URL(
  process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5433/idream",
);
const runId = Date.now();
const freshDatabaseName = `idream_admin_rehearsal_fresh_${runId}`;
const upgradeDatabaseName = `idream_admin_rehearsal_upgrade_${runId}`;
const baselineMigration = "20260711000000_baseline";
const localEvidenceTerminalMigration =
  "20260718010000_main_outbox_local_evidence_terminal";
const imageReadinessLocalEvidenceTerminalMigration =
  "20260718011000_main_outbox_image_readiness_local_evidence_terminal";
const syntheticPreviewQuarantineForwardFixMigration =
  "20260718012000_synthetic_character_preview_quarantine_forward_fix";
const migrationsDirectory = path.join(process.cwd(), "prisma", "migrations");
const adminUrl = new URL(sourceUrl);
adminUrl.pathname = "/postgres";
adminUrl.search = "";

function databaseUrl(databaseName) {
  const url = new URL(sourceUrl);
  url.pathname = `/${databaseName}`;
  url.search = "";
  return url;
}

function runPrisma(databaseName, args) {
  const result = spawnSync("bunx", ["prisma", "migrate", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl(databaseName).toString(),
      DB_PROVIDER: "postgresql",
    },
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(`${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function deploy(databaseName) {
  return runPrisma(databaseName, ["deploy"]);
}

function isNoopDeploy(output) {
  return (
    output.includes("No pending migrations") ||
    output.includes("already in sync")
  );
}

async function loadExpectedMigrationHistory() {
  const migrations = (
    await readdir(migrationsDirectory, { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return Promise.all(
    migrations.map(async (migrationName) => {
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

function evaluateMigrationHistory(rows, expectedMigrations) {
  const expectedByName = new Map(
    expectedMigrations.map((migration) => [
      migration.migrationName,
      migration.checksum,
    ]),
  );
  const actualByName = new Map(
    rows.map((migration) => [migration.migration_name, migration.checksum]),
  );
  const localOnly = expectedMigrations
    .map((migration) => migration.migrationName)
    .filter((migrationName) => !actualByName.has(migrationName));
  const databaseOnly = rows
    .map((migration) => migration.migration_name)
    .filter((migrationName) => !expectedByName.has(migrationName));
  const checksumMismatches = rows.flatMap((migration) => {
    const expectedChecksum = expectedByName.get(migration.migration_name);
    if (!expectedChecksum || expectedChecksum === migration.checksum) return [];
    return [
      {
        migrationName: migration.migration_name,
        databaseChecksum: migration.checksum,
        fileChecksum: expectedChecksum,
      },
    ];
  });
  return {
    localCount: expectedMigrations.length,
    databaseCount: rows.length,
    localOnly,
    databaseOnly,
    checksumMismatches,
    complete:
      localOnly.length === 0 &&
      databaseOnly.length === 0 &&
      rows.length === expectedMigrations.length,
    checksumsMatch: checksumMismatches.length === 0,
  };
}

async function inspectMigrationHistory(connectionString) {
  const expectedMigrations = await loadExpectedMigrationHistory();
  const db = new pg.Client({ connectionString });
  await db.connect();
  try {
    const migrationHistory = await db.query(
      `SELECT migration_name, checksum
       FROM _prisma_migrations
       WHERE finished_at IS NOT NULL
         AND rolled_back_at IS NULL
       ORDER BY migration_name`,
    );
    return evaluateMigrationHistory(migrationHistory.rows, expectedMigrations);
  } finally {
    await db.end();
  }
}

async function createDatabase(admin, databaseName) {
  await admin.query(`CREATE DATABASE "${databaseName}"`);
}

async function dropDatabase(admin, databaseName) {
  await admin
    .query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
      [databaseName],
    )
    .catch(() => undefined);
  await admin
    .query(`DROP DATABASE IF EXISTS "${databaseName}"`)
    .catch(() => undefined);
}

async function expectDeferredTransactionFailure(
  db,
  statements,
  expectedMessage,
) {
  let statementsCompleted = false;
  await db.query("BEGIN");
  try {
    for (const statement of statements) {
      await db.query(statement.text, statement.values);
    }
    statementsCompleted = true;
    await db.query("COMMIT");
    return { statementsCompleted, rejected: false, message: null };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    const expectedMessages = Array.isArray(expectedMessage)
      ? expectedMessage
      : [expectedMessage];
    return {
      statementsCompleted,
      rejected: expectedMessages.some((candidate) =>
        message.includes(candidate),
      ),
      message,
    };
  }
}

async function exerciseDeferredPublicCatalogQualificationAuthority(
  db,
  databaseName,
) {
  const fixture = `migration-rehearsal-public-qualification-${runId}-${databaseName}`;
  const userId = `${fixture}-user`;
  const characterId = `${fixture}-character`;
  const projectId = `${fixture}-project`;
  const previousAssetId = `${fixture}-previous-avatar`;
  const avatarAssetId = `${fixture}-avatar`;
  const heroAssetId = `${fixture}-hero`;
  const chatAssetId = `${fixture}-chat`;
  const releaseId = `${fixture}-release`;
  const failedReleaseId = `${fixture}-failed-release`;
  const validationId = `${fixture}-validation`;
  const failedValidationId = `${fixture}-failed-validation`;
  const qualificationId = `${fixture}-qualification`;
  const failedQualificationId = `${fixture}-failed-qualification`;
  const snapshotHash = `${fixture}-snapshot`;
  const failedSnapshotHash = `${fixture}-failed-snapshot`;
  const strictProvenance = {
    schemaVersion: "character-release-generation-provenance-v2",
    policyVersion: "character-release-policy-v2",
    requiredReleaseRoute: {
      routeFingerprint: `${fixture}-route`,
      matrixKey: "migration-rehearsal",
      generationProfileKey: "migration-profile",
      generationProfileVersion: 1,
      workflowKey: "migration-workflow",
      workflowVersion: 1,
    },
  };
  const strictManifest = {
    schemaVersion: 2,
    placements: [
      {
        slotKey: "character_avatar",
        assetId: avatarAssetId,
        slotVersion: 1,
        runId: `${fixture}-avatar-run`,
        itemId: `${fixture}-avatar-item`,
        reviewDecisionId: `${fixture}-avatar-review`,
        generationJobId: `${fixture}-avatar-generation`,
      },
      {
        slotKey: "character_hero",
        assetId: heroAssetId,
        slotVersion: 1,
        runId: `${fixture}-hero-run`,
        itemId: `${fixture}-hero-item`,
        reviewDecisionId: `${fixture}-hero-review`,
        generationJobId: `${fixture}-hero-generation`,
      },
      {
        slotKey: "character_chat",
        assetId: chatAssetId,
        slotVersion: 1,
        runId: `${fixture}-chat-run`,
        itemId: `${fixture}-chat-item`,
        reviewDecisionId: `${fixture}-chat-review`,
        generationJobId: `${fixture}-chat-generation`,
      },
    ],
  };

  await db.query(
    `INSERT INTO users (id, email, "emailVerified", role, status, "updatedAt")
     VALUES ($1, $2, false, 'admin', 'active', NOW())`,
    [userId, `${userId}@example.test`],
  );
  for (const [assetId, slot] of [
    [previousAssetId, "previous"],
    [avatarAssetId, "avatar"],
    [heroAssetId, "hero"],
    [chatAssetId, "chat"],
  ]) {
    await db.query(
      `INSERT INTO media_assets
        (id, "ownerId", type, url, "storageKey", "contentType",
         visibility, "safetyStatus", metadata)
       VALUES ($1, $2, 'image', $3, $4, 'image/png',
         'private', 'passed', '{}'::jsonb)`,
      [
        assetId,
        userId,
        `https://example.test/${fixture}/${slot}.png`,
        `${fixture}/${slot}.png`,
      ],
    );
  }
  await db.query(
    `INSERT INTO characters
      (id, "creatorId", name, age, description, visibility, status,
       "imageAssetId", appearance, "advancedDetails", "updatedAt")
     VALUES ($1, $2, 'Migration qualification Character', 28,
       'Exercises deferred public qualification authority.',
       'private', 'draft', $3, '{}'::jsonb, '{}'::jsonb, NOW())`,
    [characterId, userId, previousAssetId],
  );
  await db.query(
    `INSERT INTO character_projects
      (id, "characterId", "ownerId", phase, audience, "successCriteria",
       version, "updatedAt")
     VALUES ($1, $2, $3, 'launch_ready', '{}'::jsonb, '{}'::jsonb, 1, NOW())`,
    [projectId, characterId, userId],
  );

  async function insertGeneratedRelease(input) {
    await db.query(
      `INSERT INTO character_releases
        (id, "projectId", "revisionId", "characterContentVersionId",
         "generationProvenance", "releasePlacementManifest", "snapshotHash",
         readiness, legacy, status, "publishedAt", version, "updatedAt")
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7,
         'ready', false, 'published', NOW(), 1, NOW())`,
      [
        input.releaseId,
        projectId,
        `${input.releaseId}-revision`,
        `${input.releaseId}-content`,
        JSON.stringify(input.provenance ?? strictProvenance),
        JSON.stringify(input.manifest),
        input.snapshotHash,
      ],
    );
    await db.query(
      `INSERT INTO release_validation_runs
        (id, "releaseId", "snapshotHash", "policyVersion", result,
         "startedAt", "finishedAt")
       VALUES ($1, $2, $3, 'character-release-policy-v2', 'passed', NOW(), NOW())`,
      [input.validationId, input.releaseId, input.snapshotHash],
    );
  }

  await insertGeneratedRelease({
    releaseId,
    validationId,
    snapshotHash,
    manifest: strictManifest,
  });

  // Exact order rejected by the old statement-time trigger: qualification
  // first, then Character projection, inside one atomic transaction.
  await db.query("BEGIN");
  await db.query(
    `INSERT INTO public_catalog_qualifications
      (id, "releaseId", "releaseSnapshotHash", kind, "validationRunId",
       evidence, "qualifiedAt")
     VALUES ($1, $2, $3, 'generated_release', $4, $5::jsonb, NOW())`,
    [
      qualificationId,
      releaseId,
      snapshotHash,
      validationId,
      JSON.stringify({
        schemaVersion: "public-catalog-qualification-v1",
        policyVersion: "character-release-policy-v2",
      }),
    ],
  );
  await db.query(
    `UPDATE characters SET "imageAssetId" = $2, "updatedAt" = NOW()
     WHERE id = $1`,
    [characterId, avatarAssetId],
  );
  await db.query("COMMIT");
  const committedQualification = await db.query(
    `SELECT id FROM public_catalog_qualifications WHERE id = $1`,
    [qualificationId],
  );

  const mismatchedManifest = {
    ...strictManifest,
    placements: strictManifest.placements.map((placement) =>
      placement.slotKey === "character_avatar"
        ? { ...placement, assetId: previousAssetId }
        : placement,
    ),
  };
  await insertGeneratedRelease({
    releaseId: failedReleaseId,
    validationId: failedValidationId,
    snapshotHash: failedSnapshotHash,
    manifest: mismatchedManifest,
  });
  const mismatchedQualification = await expectDeferredTransactionFailure(
    db,
    [
      {
        text: `INSERT INTO public_catalog_qualifications
        (id, "releaseId", "releaseSnapshotHash", kind, "validationRunId",
         evidence, "qualifiedAt")
       VALUES ($1, $2, $3, 'generated_release', $4, $5::jsonb, NOW())`,
        values: [
          failedQualificationId,
          failedReleaseId,
          failedSnapshotHash,
          failedValidationId,
          JSON.stringify({
            schemaVersion: "public-catalog-qualification-v1",
            policyVersion: "character-release-policy-v2",
          }),
        ],
      },
    ],
    "public catalog qualification requires the exact Character avatar projection",
  );
  const failedQualificationCount = await db.query(
    `SELECT count(*)::integer AS count
     FROM public_catalog_qualifications
     WHERE id = $1`,
    [failedQualificationId],
  );

  async function rejectMalformedGeneratedAuthority(kind, provenance) {
    const malformedReleaseId = `${fixture}-${kind}-release`;
    const malformedValidationId = `${fixture}-${kind}-validation`;
    const malformedQualificationId = `${fixture}-${kind}-qualification`;
    const malformedSnapshotHash = `${fixture}-${kind}-snapshot`;
    await insertGeneratedRelease({
      releaseId: malformedReleaseId,
      validationId: malformedValidationId,
      snapshotHash: malformedSnapshotHash,
      manifest: strictManifest,
      provenance,
    });
    const rejection = await expectDeferredTransactionFailure(
      db,
      [
        {
          text: `INSERT INTO public_catalog_qualifications
          (id, "releaseId", "releaseSnapshotHash", kind, "validationRunId",
           evidence, "qualifiedAt")
         VALUES ($1, $2, $3, 'generated_release', $4, $5::jsonb, NOW())`,
          values: [
            malformedQualificationId,
            malformedReleaseId,
            malformedSnapshotHash,
            malformedValidationId,
            JSON.stringify({
              schemaVersion: "public-catalog-qualification-v1",
              policyVersion: "character-release-policy-v2",
            }),
          ],
        },
      ],
      "generated public qualification requires exact policy and required route authority",
    );
    const preserved = await db.query(
      `SELECT count(*)::integer AS count
       FROM public_catalog_qualifications
       WHERE id = $1`,
      [malformedQualificationId],
    );
    return {
      ...rejection,
      rolledBack: preserved.rows[0]?.count === 0,
    };
  }

  const missingPolicyAuthority = await rejectMalformedGeneratedAuthority(
    "missing-policy",
    {
      schemaVersion: strictProvenance.schemaVersion,
      requiredReleaseRoute: strictProvenance.requiredReleaseRoute,
    },
  );
  const topLevelRouteAuthority = await rejectMalformedGeneratedAuthority(
    "top-level-route",
    {
      schemaVersion: strictProvenance.schemaVersion,
      policyVersion: strictProvenance.policyVersion,
      ...strictProvenance.requiredReleaseRoute,
    },
  );

  await db.query("BEGIN");
  await db.query(
    `UPDATE media_assets
     SET "characterId" = $1, visibility = 'public_pack'
     WHERE id = ANY($2::text[])`,
    [characterId, [avatarAssetId, heroAssetId, chatAssetId]],
  );
  await db.query(
    `UPDATE characters
     SET status = 'approved', visibility = 'public', "updatedAt" = NOW()
     WHERE id = $1`,
    [characterId],
  );
  await db.query(
    `INSERT INTO character_serving
      (id, "characterId", "currentReleaseId", state, version, "updatedAt")
     VALUES ($1, $2, $3, 'live', 1, NOW())`,
    [`${fixture}-serving`, characterId, releaseId],
  );
  await db.query("COMMIT");

  async function rejectMalformedManifestAuthority(kind, manifest) {
    const malformedReleaseId = `${fixture}-${kind}-release`;
    const malformedValidationId = `${fixture}-${kind}-validation`;
    const malformedQualificationId = `${fixture}-${kind}-qualification`;
    const malformedSnapshotHash = `${fixture}-${kind}-snapshot`;
    await insertGeneratedRelease({
      releaseId: malformedReleaseId,
      validationId: malformedValidationId,
      snapshotHash: malformedSnapshotHash,
      manifest,
    });
    const rejection = await expectDeferredTransactionFailure(
      db,
      [
        {
          text: `INSERT INTO public_catalog_qualifications
            (id, "releaseId", "releaseSnapshotHash", kind, "validationRunId",
             evidence, "qualifiedAt")
           VALUES ($1, $2, $3, 'generated_release', $4, $5::jsonb, NOW())`,
          values: [
            malformedQualificationId,
            malformedReleaseId,
            malformedSnapshotHash,
            malformedValidationId,
            JSON.stringify({
              schemaVersion: "public-catalog-qualification-v1",
              policyVersion: "character-release-policy-v2",
            }),
          ],
        },
        {
          text: `UPDATE character_serving
           SET "currentReleaseId" = $2,
               version = version + 1,
               "updatedAt" = NOW()
           WHERE "characterId" = $1`,
          values: [characterId, malformedReleaseId],
        },
      ],
      "live public generated Character requires strict v2 Release manifest contract",
    );
    const preserved = await db.query(
      `SELECT
         serving."currentReleaseId" = $2 AS "servingPreserved",
         NOT EXISTS (
           SELECT 1
           FROM public_catalog_qualifications qualification
           WHERE qualification.id = $3
         ) AS "qualificationRolledBack"
       FROM character_serving serving
       WHERE serving."characterId" = $1`,
      [characterId, releaseId, malformedQualificationId],
    );
    if (!rejection.rejected) {
      await db.query("BEGIN");
      await db.query(
        `UPDATE character_serving
         SET "currentReleaseId" = $2,
             version = version + 1,
             "updatedAt" = NOW()
         WHERE "characterId" = $1`,
        [characterId, releaseId],
      );
      await db.query("COMMIT");
    }
    return {
      ...rejection,
      rolledBack:
        preserved.rows[0]?.servingPreserved === true &&
        preserved.rows[0]?.qualificationRolledBack === true,
    };
  }

  const missingLineageManifest = {
    ...strictManifest,
    placements: strictManifest.placements.map((placement) => {
      if (placement.slotKey !== "character_chat") return placement;
      const malformed = { ...placement };
      delete malformed.generationJobId;
      return malformed;
    }),
  };
  const missingLineageManifestAuthority =
    await rejectMalformedManifestAuthority(
      "missing-lineage",
      missingLineageManifest,
    );
  const unsafeSlotVersionManifest = {
    ...strictManifest,
    placements: strictManifest.placements.map((placement) =>
      placement.slotKey === "character_hero"
        ? { ...placement, slotVersion: 9_007_199_254_740_992 }
        : placement,
    ),
  };
  const unsafeSlotVersionAuthority = await rejectMalformedManifestAuthority(
    "unsafe-slot-version",
    unsafeSlotVersionManifest,
  );
  const tabOnlyLineageManifest = {
    ...strictManifest,
    placements: strictManifest.placements.map((placement) =>
      placement.slotKey === "character_chat"
        ? { ...placement, runId: "\t" }
        : placement,
    ),
  };
  const tabOnlyLineageAuthority = await rejectMalformedManifestAuthority(
    "tab-only-lineage",
    tabOnlyLineageManifest,
  );

  const unhydratableHeroAsset = await expectDeferredTransactionFailure(
    db,
    [
      {
        text: `UPDATE media_assets
       SET "storageKey" = NULL,
           url = $2
       WHERE id = $1`,
        values: [heroAssetId, `/user-content/${fixture}/hero-relative.png`],
      },
    ],
    "live public generated Character requires three exact hydratable Character assets",
  );
  const heroAfterRejectedBlobUpdate = await db.query(
    `SELECT "storageKey", url
     FROM media_assets
     WHERE id = $1`,
    [heroAssetId],
  );

  const privateHeroAsset = await expectDeferredTransactionFailure(
    db,
    [
      {
        text: `UPDATE media_assets
       SET visibility = 'private'
       WHERE id = $1`,
        values: [heroAssetId],
      },
    ],
    "live public generated Character requires three exact publishable Character assets",
  );
  const heroAfterRejectedUpdate = await db.query(
    `SELECT visibility FROM media_assets WHERE id = $1`,
    [heroAssetId],
  );

  const blockedChatAsset = await expectDeferredTransactionFailure(
    db,
    [
      {
        text: `UPDATE media_assets
       SET metadata = jsonb_set(
         metadata,
         '{platformAsset}',
         '{"status":"blocked"}'::jsonb,
         true
       )
       WHERE id = $1`,
        values: [chatAssetId],
      },
    ],
    "live public generated Character requires three exact publishable Character assets",
  );
  const chatAfterRejectedUpdate = await db.query(
    `SELECT metadata#>>'{platformAsset,status}' AS "platformStatus"
     FROM media_assets
     WHERE id = $1`,
    [chatAssetId],
  );

  const deletedHeroAsset = await expectDeferredTransactionFailure(
    db,
    [
      {
        text: `DELETE FROM media_assets WHERE id = $1`,
        values: [heroAssetId],
      },
    ],
    "live public generated Character requires three exact publishable Character assets",
  );
  const heroAfterRejectedDelete = await db.query(
    `SELECT count(*)::integer AS count
     FROM media_assets
     WHERE id = $1`,
    [heroAssetId],
  );

  await db.query(
    `ALTER TABLE public_catalog_qualifications
     DISABLE TRIGGER public_catalog_qualification_authority`,
  );
  let secondaryDeleteActiveQualification;
  try {
    secondaryDeleteActiveQualification = await expectDeferredTransactionFailure(
      db,
      [
        {
          text: `DELETE FROM public_catalog_qualifications WHERE id = $1`,
          values: [qualificationId],
        },
      ],
      "live public Character requires one exact non-revoked qualification",
    );
  } finally {
    await db.query(
      `ALTER TABLE public_catalog_qualifications
       ENABLE TRIGGER public_catalog_qualification_authority`,
    );
  }
  const liveChainAfterSecondaryRejectedDelete = await db.query(
    `SELECT qualification.id AS "qualificationId"
     FROM character_serving serving
     JOIN public_catalog_qualifications qualification
       ON qualification."releaseId" = serving."currentReleaseId"
     WHERE serving."characterId" = $1
       AND serving.state = 'live'`,
    [characterId],
  );

  const deleteActiveQualification = await expectDeferredTransactionFailure(
    db,
    [
      {
        text: `DELETE FROM public_catalog_qualifications WHERE id = $1`,
        values: [qualificationId],
      },
    ],
    [
      "public catalog qualification cannot be deleted; revoke it instead",
      "live public Character requires one exact non-revoked qualification",
    ],
  );
  const liveChainAfterRejectedDelete = await db.query(
    `SELECT
       serving.state,
       serving."currentReleaseId",
       qualification.id AS "qualificationId",
       qualification."revokedAt"
     FROM character_serving serving
     JOIN public_catalog_qualifications qualification
       ON qualification."releaseId" = serving."currentReleaseId"
     WHERE serving."characterId" = $1`,
    [characterId],
  );

  const immutableUpdate = await expectDeferredTransactionFailure(
    db,
    [
      {
        text: `UPDATE public_catalog_qualifications
       SET evidence = '{"tampered":true}'::jsonb
       WHERE id = $1`,
        values: [qualificationId],
      },
    ],
    "public catalog qualification is immutable except for one-way revocation",
  );
  const evidenceAfterRejectedUpdate = await db.query(
    `SELECT evidence FROM public_catalog_qualifications WHERE id = $1`,
    [qualificationId],
  );

  await db.query("BEGIN");
  await db.query(
    `UPDATE character_serving
     SET state = 'paused', version = version + 1, "updatedAt" = NOW()
     WHERE "characterId" = $1`,
    [characterId],
  );
  await db.query(
    `UPDATE public_catalog_qualifications SET "revokedAt" = NOW() WHERE id = $1`,
    [qualificationId],
  );
  await db.query("COMMIT");
  const revokedQualification = await db.query(
    `SELECT "revokedAt" FROM public_catalog_qualifications WHERE id = $1`,
    [qualificationId],
  );
  const unrevocation = await expectDeferredTransactionFailure(
    db,
    [
      {
        text: `UPDATE public_catalog_qualifications
       SET "revokedAt" = NULL
       WHERE id = $1`,
        values: [qualificationId],
      },
    ],
    "public catalog qualification is immutable except for one-way revocation",
  );
  const revocationAfterRejectedUpdate = await db.query(
    `SELECT "revokedAt" FROM public_catalog_qualifications WHERE id = $1`,
    [qualificationId],
  );

  return {
    committedAfterQualificationBeforeProjection:
      committedQualification.rowCount === 1,
    mismatchedQualification,
    failedQualificationRolledBack:
      failedQualificationCount.rows[0]?.count === 0,
    missingPolicyAuthority,
    topLevelRouteAuthority,
    missingLineageManifestAuthority,
    unsafeSlotVersionAuthority,
    tabOnlyLineageAuthority,
    unhydratableHeroAsset,
    unhydratableHeroAssetRolledBack:
      heroAfterRejectedBlobUpdate.rows[0]?.storageKey ===
        `${fixture}/hero.png` &&
      heroAfterRejectedBlobUpdate.rows[0]?.url ===
        `https://example.test/${fixture}/hero.png`,
    privateHeroAsset,
    privateHeroAssetRolledBack:
      heroAfterRejectedUpdate.rows[0]?.visibility === "public_pack",
    blockedChatAsset,
    blockedChatAssetRolledBack:
      chatAfterRejectedUpdate.rows[0]?.platformStatus === null,
    deletedHeroAsset,
    deletedHeroAssetRolledBack: heroAfterRejectedDelete.rows[0]?.count === 1,
    secondaryDeleteActiveQualification,
    secondaryDeleteRolledBack:
      liveChainAfterSecondaryRejectedDelete.rowCount === 1 &&
      liveChainAfterSecondaryRejectedDelete.rows[0]?.qualificationId ===
        qualificationId,
    deleteActiveQualification,
    activeQualificationDeleteRolledBack:
      liveChainAfterRejectedDelete.rowCount === 1 &&
      liveChainAfterRejectedDelete.rows[0]?.state === "live" &&
      liveChainAfterRejectedDelete.rows[0]?.currentReleaseId === releaseId &&
      liveChainAfterRejectedDelete.rows[0]?.qualificationId ===
        qualificationId &&
      liveChainAfterRejectedDelete.rows[0]?.revokedAt === null,
    immutableUpdate,
    immutableEvidencePreserved:
      evidenceAfterRejectedUpdate.rows[0]?.evidence?.tampered !== true,
    oneWayRevocationCommitted:
      revokedQualification.rows[0]?.revokedAt instanceof Date,
    unrevocation,
    revocationPreserved:
      revocationAfterRejectedUpdate.rows[0]?.revokedAt instanceof Date,
  };
}

async function exerciseLocalEvidenceTerminalMigration(db, databaseName) {
  const fixture = `migration-rehearsal-local-evidence-${runId}-${databaseName}`;
  const fixtures = [
    {
      id: `${fixture}-qualification`,
      eventType: "character.release.qualification_stale.v2",
      status: "pending",
      attempts: 3,
      payload: { evidence: "qualification" },
      lastError: { message: "historical pending transport" },
      createdAt: new Date("2026-07-17T09:44:40.000Z"),
    },
    {
      id: `${fixture}-editorial`,
      eventType: "character.editorial_authority_repaired.v1",
      status: "dispatched",
      attempts: 5,
      payload: { evidence: "editorial" },
      lastError: "historical scalar error",
      createdAt: new Date("2026-07-17T11:21:44.000Z"),
    },
    {
      id: `${fixture}-image-readiness`,
      eventType: "character.image_readiness.repaired.v1",
      status: "pending",
      attempts: 2,
      payload: { evidence: "image-readiness" },
      lastError: null,
      createdAt: new Date("2026-07-18T01:10:00.000Z"),
    },
    {
      id: `${fixture}-unrelated`,
      eventType: "character.release.monitor_evaluated.v2",
      status: "pending",
      attempts: 7,
      payload: { evidence: "unrelated" },
      lastError: null,
      createdAt: new Date("2000-01-01T00:00:00.000Z"),
    },
  ];
  for (const row of fixtures) {
    await db.query(
      `INSERT INTO main_outbox_events
        (id, "eventType", "aggregateType", "aggregateId", payload,
         status, attempts, "nextRunAt", "lastError", "createdAt", "updatedAt")
       VALUES
        ($1, $2, 'character_release', $3, $4::jsonb,
         $5, $6, $7, $8::jsonb, $7, $7)`,
      [
        row.id,
        row.eventType,
        `${fixture}-release`,
        JSON.stringify(row.payload),
        row.status,
        row.attempts,
        row.createdAt,
        row.lastError === null ? null : JSON.stringify(row.lastError),
      ],
    );
  }

  const migrationSql = await Promise.all(
    [
      localEvidenceTerminalMigration,
      imageReadinessLocalEvidenceTerminalMigration,
    ].map((migration) =>
      readFile(
        path.join(migrationsDirectory, migration, "migration.sql"),
        "utf8",
      ),
    ),
  );
  for (const sql of migrationSql) await db.query(sql);
  const first = await db.query(
    `SELECT
       id, "eventType", payload, status, attempts, "deliveredAt",
       "lastError", "createdAt", "updatedAt"
     FROM main_outbox_events
     WHERE id LIKE $1
     ORDER BY id`,
    [`${fixture}%`],
  );
  for (const sql of migrationSql) await db.query(sql);
  const second = await db.query(
    `SELECT
       id, "eventType", payload, status, attempts, "deliveredAt",
       "lastError", "createdAt", "updatedAt"
     FROM main_outbox_events
     WHERE id LIKE $1
     ORDER BY id`,
    [`${fixture}%`],
  );
  const firstById = new Map(first.rows.map((row) => [row.id, row]));
  const terminalRows = fixtures.slice(0, 3).map((row) => ({
    fixture: row,
    persisted: firstById.get(row.id),
  }));
  const unrelated = firstById.get(fixtures[3].id);
  return {
    rows: first.rows,
    targetRowsTerminal: terminalRows.every(
      ({ fixture: expected, persisted }) =>
        persisted?.status === "delivered" &&
        persisted.deliveredAt instanceof Date &&
        persisted.deliveredAt.getTime() === expected.createdAt.getTime(),
    ),
    targetEvidencePreserved: terminalRows.every(
      ({ fixture: expected, persisted }) =>
        persisted?.attempts === expected.attempts &&
        persisted.payload?.evidence === expected.payload.evidence,
    ),
    terminalReasonRecorded: terminalRows.every(
      ({ fixture: expected, persisted }) =>
        persisted?.lastError?.outcome === "local_evidence" &&
        persisted.lastError.reason === "local_evidence_has_no_transport_sink" &&
        persisted.lastError.terminalizedBy ===
          (expected.eventType === "character.image_readiness.repaired.v1"
            ? imageReadinessLocalEvidenceTerminalMigration
            : localEvidenceTerminalMigration),
    ),
    previousErrorPreserved:
      firstById.get(fixtures[0].id)?.lastError?.message ===
        "historical pending transport" &&
      firstById.get(fixtures[1].id)?.lastError?.previousLastError ===
        "historical scalar error",
    unrelatedRowPreserved:
      unrelated?.status === "pending" &&
      unrelated.deliveredAt === null &&
      unrelated.attempts === fixtures[3].attempts &&
      unrelated.payload?.evidence === fixtures[3].payload.evidence &&
      unrelated.lastError === null,
    repeatedApplicationNoop:
      JSON.stringify(first.rows) === JSON.stringify(second.rows),
  };
}

async function exerciseSyntheticPreviewQuarantineForwardFix(db, databaseName) {
  const fixture = `migration-rehearsal-synthetic-preview-${runId}-${databaseName}`;
  const userId = `${fixture}-user`;
  const tolerantAssetId = `${fixture}-yes`;
  const unrelatedAssetId = `${fixture}-unrelated`;
  await db.query(
    `INSERT INTO users (id, email, "emailVerified", role, status, "updatedAt")
     VALUES ($1, $2, false, 'user', 'active', NOW())`,
    [userId, `${userId}@example.test`],
  );
  for (const [assetId, synthetic] of [
    [tolerantAssetId, "yes"],
    [unrelatedAssetId, "legacy"],
  ]) {
    await db.query(
      `INSERT INTO media_assets
        (id, "ownerId", type, url, "storageKey", "contentType",
         visibility, "safetyStatus", metadata)
       VALUES ($1, $2, 'image', $3, $4, 'image/png',
         'private', 'passed', $5::jsonb)`,
      [
        assetId,
        userId,
        `https://example.test/${fixture}/${synthetic}.png`,
        `${fixture}/${synthetic}.png`,
        JSON.stringify({
          source: "character_preview",
          synthetic,
        }),
      ],
    );
  }

  const migrationSql = await readFile(
    path.join(
      migrationsDirectory,
      syntheticPreviewQuarantineForwardFixMigration,
      "migration.sql",
    ),
    "utf8",
  );
  await db.query(migrationSql);
  const first = await db.query(
    `SELECT id, visibility, "characterId", metadata
     FROM media_assets
     WHERE id = ANY($1::text[])
     ORDER BY id`,
    [[tolerantAssetId, unrelatedAssetId]],
  );
  await db.query(migrationSql);
  const second = await db.query(
    `SELECT id, visibility, "characterId", metadata
     FROM media_assets
     WHERE id = ANY($1::text[])
     ORDER BY id`,
    [[tolerantAssetId, unrelatedAssetId]],
  );
  const firstById = new Map(first.rows.map((row) => [row.id, row]));
  const tolerant = firstById.get(tolerantAssetId);
  const unrelated = firstById.get(unrelatedAssetId);
  return {
    tolerantSyntheticValueQuarantined:
      tolerant?.visibility === "unlisted" &&
      tolerant.characterId === null &&
      tolerant.metadata?.quarantined === true &&
      tolerant.metadata?.quarantineReason === "synthetic_character_preview",
    unrelatedValuePreserved:
      unrelated?.visibility === "private" &&
      unrelated.characterId === null &&
      unrelated.metadata?.synthetic === "legacy" &&
      unrelated.metadata?.quarantined === undefined,
    repeatedApplicationNoop:
      JSON.stringify(first.rows) === JSON.stringify(second.rows),
  };
}

async function exerciseRuntimeSchemaReconciliation(db, databaseName) {
  const fixture = `runtime-reconciliation-${runId}-${databaseName}`;
  const modelProfileId = `${fixture}-model-profile`;
  const artifactId = `${fixture}-artifact`;
  const userId = `${fixture}-user`;
  const characterId = `${fixture}-character`;
  const visualProfileId = `${fixture}-visual-profile`;
  const referenceSetRevisionId = `${fixture}-reference-set`;
  const coveredAssetId = `${fixture}-covered-asset`;
  const missingAssetId = `${fixture}-missing-asset`;
  await db.query(
    `INSERT INTO generation_model_profiles
      (id, "profileKey", label, runner, "pipelineModel",
       "allowedOrientations", "updatedAt")
     VALUES ($1, $2, 'Legacy runner rehearsal', 'sd_cpp',
       'legacy-runner-rehearsal', '["portrait"]'::jsonb, NOW())`,
    [modelProfileId, `${fixture}-profile-key`],
  );
  await db.query(
    `INSERT INTO generation_artifacts
      (id, "attemptId", ordinal, "terminalRecordChecksum", "validationState")
     VALUES ($1, $2, 1, $3, 'late_after_cancel')`,
    [artifactId, `${fixture}-attempt`, `${fixture}-checksum`],
  );

  const migrationSql = await readFile(
    path.join(
      migrationsDirectory,
      "20260811143000_runtime_schema_reconciliation",
      "migration.sql",
    ),
    "utf8",
  );

  // The migration has already run through Prisma on this disposable database.
  // Recreate only the retired shadow shape so direct execution can prove the
  // manual-partial states without changing migration history.
  await db.query(
    `ALTER TABLE character_visual_profiles
       ADD COLUMN "referenceAssetIds" JSONB NOT NULL DEFAULT '[]'::jsonb`,
  );
  await db.query(
    `INSERT INTO users
      (id, email, "emailVerified", role, status, "updatedAt")
     VALUES ($1, $2, false, 'admin', 'active', NOW())`,
    [userId, `${userId}@example.test`],
  );
  await db.query(
    `INSERT INTO characters
      (id, "creatorId", name, age, description, appearance,
       "advancedDetails", "updatedAt")
     VALUES ($1, $2, 'Runtime reconciliation Character', 28,
       'Verifies profile shadow parity before destructive DDL.',
       '{}'::jsonb, '{}'::jsonb, NOW())`,
    [characterId, userId],
  );
  await db.query(
    `INSERT INTO media_assets
      (id, "ownerId", type, url, "storageKey", "contentType",
       visibility, "safetyStatus", metadata)
     VALUES
       ($1, $3, 'image', $4, $5, 'image/png', 'private', 'passed', '{}'::jsonb),
       ($2, $3, 'image', $6, $7, 'image/png', 'private', 'passed', '{}'::jsonb)`,
    [
      coveredAssetId,
      missingAssetId,
      userId,
      `https://example.test/${coveredAssetId}.png`,
      `${fixture}/covered.png`,
      `https://example.test/${missingAssetId}.png`,
      `${fixture}/missing.png`,
    ],
  );
  await db.query(
    `INSERT INTO character_visual_profiles
      (id, "characterId", status, "identityPrompt",
       "faceTraits", "hairTraits", "bodyTraits", "signatureTraits",
       "styleTraits", "anchorAssetIds", "referenceAssetIds",
       "adapterRefs", "createdFrom", "updatedAt")
     VALUES ($1, $2, 'active', 'Stable reconciliation identity',
       '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
       '{}'::jsonb, '[]'::jsonb, '{"unexpected":"shape"}'::jsonb,
       '[]'::jsonb, 'migration_rehearsal', NOW())`,
    [visualProfileId, characterId],
  );
  await db.query(
    `INSERT INTO reference_set_revisions
      (id, "visualProfileId", revision, status, "createdFrom")
     VALUES ($1, $2, 1, 'active', 'migration_rehearsal')`,
    [referenceSetRevisionId, visualProfileId],
  );
  await db.query(
    `INSERT INTO character_visual_reference_snapshots
      (id, "referenceSetRevisionId", "mediaAssetId", position, role,
       "selectionReason")
     VALUES ($1, $2, $3, 0, 'identity_reference', 'migration_rehearsal')`,
    [`${fixture}-covered-snapshot`, referenceSetRevisionId, coveredAssetId],
  );

  async function expectMigrationRejection(expectedMessage) {
    try {
      await db.query(migrationSql);
      return false;
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      return (
        error?.code === "23514" && String(error.message).includes(expectedMessage)
      );
    }
  }

  async function rejectedStateWasPreserved(expectedShadow) {
    const state = await db.query(
      `SELECT
         (SELECT runner FROM generation_model_profiles WHERE id = $1) AS runner,
         (SELECT "validationState" FROM generation_artifacts WHERE id = $2)
           AS artifact_state,
         EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'character_visual_profiles'
             AND column_name = 'referenceAssetIds'
         ) AS visual_profile_shadow_exists`,
      [modelProfileId, artifactId],
    );
    const row = state.rows[0] ?? {};
    if (row.visual_profile_shadow_exists !== true) return false;
    const shadow = await db.query(
      `SELECT "referenceAssetIds" AS value
       FROM character_visual_profiles
       WHERE id = $1`,
      [visualProfileId],
    );
    return (
      row.runner === "sd_cpp" &&
      row.artifact_state === "late_after_cancel" &&
      JSON.stringify(shadow.rows[0]?.value) === JSON.stringify(expectedShadow)
    );
  }

  const malformedShadowRejected = await expectMigrationRejection(
    "referenceAssetIds must be a JSON array of non-empty media asset ids",
  );
  const malformedShadowTransactionRolledBack =
    await rejectedStateWasPreserved({ unexpected: "shape" });

  const driftedShadow = [coveredAssetId, missingAssetId];
  await db.query(
    `UPDATE character_visual_profiles
     SET "referenceAssetIds" = $2::jsonb
     WHERE id = $1`,
    [visualProfileId, JSON.stringify(driftedShadow)],
  );
  const driftedShadowRejected = await expectMigrationRejection(
    "referenceAssetIds shadow parity failed",
  );
  const driftedShadowTransactionRolledBack =
    await rejectedStateWasPreserved(driftedShadow);

  await db.query(
    `INSERT INTO character_visual_reference_snapshots
      (id, "referenceSetRevisionId", "mediaAssetId", position, role,
       "selectionReason")
     VALUES ($1, $2, $3, 1, 'identity_reference', 'migration_rehearsal')`,
    [`${fixture}-missing-snapshot`, referenceSetRevisionId, missingAssetId],
  );
  await db.query(migrationSql);

  const authority = await db.query(
    `SELECT
       (SELECT runner FROM generation_model_profiles WHERE id = $1) AS runner,
       (SELECT "validationState" FROM generation_artifacts WHERE id = $2)
         AS artifact_state,
       (SELECT column_default
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'generation_model_profiles'
           AND column_name = 'runner') AS runner_default,
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'character_visual_profiles'
           AND column_name = 'referenceAssetIds'
       ) AS visual_profile_shadow_exists,
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'generation_jobs'
           AND column_name = 'referenceAssetIds'
       ) AS generation_job_reference_snapshot_exists`,
    [modelProfileId, artifactId],
  );
  await db.query("DELETE FROM character_visual_profiles WHERE id = $1", [
    visualProfileId,
  ]);
  await db.query("DELETE FROM media_assets WHERE id = ANY($1::text[])", [
    [coveredAssetId, missingAssetId],
  ]);
  await db.query("DELETE FROM characters WHERE id = $1", [characterId]);
  await db.query("DELETE FROM users WHERE id = $1", [userId]);
  await db.query("DELETE FROM generation_artifacts WHERE id = $1", [
    artifactId,
  ]);
  await db.query("DELETE FROM generation_model_profiles WHERE id = $1", [
    modelProfileId,
  ]);
  const row = authority.rows[0] ?? {};
  return {
    malformedShadowRejected,
    malformedShadowTransactionRolledBack,
    driftedShadowRejected,
    driftedShadowTransactionRolledBack,
    runnerBackfilled: row.runner === "comfyui",
    artifactStateBackfilled: row.artifact_state === "late_after_cancelled",
    runnerDefaultReconciled:
      typeof row.runner_default === "string" &&
      row.runner_default.includes("comfyui"),
    visualProfileShadowRemoved: row.visual_profile_shadow_exists === false,
    generationJobReferenceSnapshotPreserved:
      row.generation_job_reference_snapshot_exists === true,
  };
}

async function inspectExpandedSchema(databaseName) {
  const db = new pg.Client({
    connectionString: databaseUrl(databaseName).toString(),
  });
  await db.connect();
  try {
    const runtimeSchemaReconciliation =
      await exerciseRuntimeSchemaReconciliation(db, databaseName);
    const tables = await db.query(
      `SELECT tablename
       FROM pg_tables
       WHERE schemaname = 'public' AND tablename = ANY($1::text[])
       ORDER BY tablename`,
      [
        [
          "character_serving",
          "character_qa_runs",
          "control_plane_commands",
          "generation_transport_executions",
          "incident_postmortems",
          "metric_definition_snapshots",
        ],
      ],
    );
    const triggers = await db.query(
      `SELECT tgname
       FROM pg_trigger
       WHERE NOT tgisinternal AND tgname = ANY($1::text[])
       ORDER BY tgname`,
      [
        [
          "analytics_events_immutable",
          "character_release_snapshot_immutable",
          "character_qa_runs_immutable_update",
          "generation_attempt_terminal_event_required",
          "generation_transport_execution_lifecycle",
          "incident_postmortems_immutable",
        ],
      ],
    );
    const generationColumns = await db.query(
      `SELECT column_name, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'generation_jobs'
         AND column_name = ANY($1::text[])
       ORDER BY column_name`,
      [["deliveredOutputCount", "finishedAt", "version"]],
    );
    const servingConstraints = await db.query(
      `SELECT conname, condeferrable, convalidated
       FROM pg_constraint
       WHERE conname LIKE 'character_serving_%_fkey'
       ORDER BY conname`,
    );
    const unvalidated = servingConstraints.rows.filter(
      (row) => !row.convalidated,
    );
    for (const constraint of unvalidated) {
      await db.query(
        `ALTER TABLE character_serving VALIDATE CONSTRAINT "${constraint.conname}"`,
      );
    }
    const validatedServingConstraints = await db.query(
      `SELECT conname, condeferrable, convalidated
       FROM pg_constraint
       WHERE conname LIKE 'character_serving_%_fkey'
       ORDER BY conname`,
    );
    const migrationHistory = await db.query(
      `SELECT migration_name, checksum, finished_at, rolled_back_at
       FROM _prisma_migrations
       ORDER BY migration_name`,
    );
    const referenceSetActiveIndexes = await db.query(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'reference_set_revisions'
         AND indexname =
           'reference_set_revisions_one_active_per_visual_profile_key'`,
    );
    const publicQualificationAuthorityTriggers = await db.query(
      `SELECT
         tgname,
         tgdeferrable,
         tginitdeferred,
         pg_get_triggerdef(oid) AS definition
       FROM pg_trigger
       WHERE NOT tgisinternal
         AND tgrelid = 'public_catalog_qualifications'::regclass
         AND tgname = ANY($1::text[])
       ORDER BY tgname`,
      [
        [
          "live_public_authority_v2_from_qualification_delete",
          "public_catalog_qualification_authority",
          "public_catalog_qualification_policy_route_authority",
        ],
      ],
    );
    const livePublicMediaAssetAuthorityTriggers = await db.query(
      `SELECT
         tgname,
         tgdeferrable,
         tginitdeferred,
         pg_get_triggerdef(oid) AS definition
       FROM pg_trigger
       WHERE NOT tgisinternal
         AND tgrelid = 'media_assets'::regclass
         AND tgname = 'live_public_authority_v2_from_media_asset'`,
    );
    const accountDeletionAuthorityTriggers = await db.query(
      `SELECT
         tgname,
         tgdeferrable,
         tginitdeferred,
         pg_get_triggerdef(oid) AS definition
       FROM pg_trigger
       WHERE NOT tgisinternal
         AND tgrelid = 'users'::regclass
         AND tgname = 'customer_account_deletion_authority_required'`,
    );
    const publicQualificationAuthority =
      await exerciseDeferredPublicCatalogQualificationAuthority(
        db,
        databaseName,
      );
    const localEvidenceTerminal = await exerciseLocalEvidenceTerminalMigration(
      db,
      databaseName,
    );
    const syntheticPreviewQuarantineForwardFix =
      await exerciseSyntheticPreviewQuarantineForwardFix(db, databaseName);
    const referenceSetFixture = `migration-rehearsal-reference-set-${runId}-${databaseName}`;
    let duplicateActiveReferenceSetRejected = false;
    await db.query("BEGIN");
    try {
      await db.query(
        `INSERT INTO characters
          (id, name, age, description, appearance, "advancedDetails", "updatedAt")
         VALUES ($1, 'Migration rehearsal Character', 28,
           'Verifies Reference Set database authority.',
           '{}'::jsonb, '{}'::jsonb, NOW())`,
        [`${referenceSetFixture}-character`],
      );
      await db.query(
        `INSERT INTO character_visual_profiles
          (id, "characterId", status, "identityPrompt",
           "faceTraits", "hairTraits", "bodyTraits", "signatureTraits",
           "styleTraits", "anchorAssetIds",
           "adapterRefs", "createdFrom", "updatedAt")
         VALUES ($1, $2, 'active', 'Stable rehearsal identity',
           '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
           '{}'::jsonb, '[]'::jsonb,
           '[]'::jsonb, 'migration_rehearsal', NOW())`,
        [`${referenceSetFixture}-profile`, `${referenceSetFixture}-character`],
      );
      await db.query(
        `INSERT INTO reference_set_revisions
          (id, "visualProfileId", revision, status, "createdFrom")
         VALUES ($1, $2, 1, 'active', 'migration_rehearsal')`,
        [`${referenceSetFixture}-revision-1`, `${referenceSetFixture}-profile`],
      );
      await db.query("SAVEPOINT duplicate_active_reference_set");
      try {
        await db.query(
          `INSERT INTO reference_set_revisions
            (id, "visualProfileId", revision, status, "createdFrom")
           VALUES ($1, $2, 2, 'active', 'migration_rehearsal')`,
          [
            `${referenceSetFixture}-revision-2`,
            `${referenceSetFixture}-profile`,
          ],
        );
      } catch (error) {
        duplicateActiveReferenceSetRejected =
          error?.code === "23505" &&
          error?.constraint ===
            "reference_set_revisions_one_active_per_visual_profile_key";
        await db.query("ROLLBACK TO SAVEPOINT duplicate_active_reference_set");
      }
    } finally {
      await db.query("ROLLBACK");
    }
    const expectedMigrations = await loadExpectedMigrationHistory();
    const migrationHistoryAuthority = evaluateMigrationHistory(
      migrationHistory.rows.filter(
        (row) => row.finished_at !== null && row.rolled_back_at === null,
      ),
      expectedMigrations,
    );
    const qaRunId = `migration-rehearsal-qa-${runId}`;
    await db.query(
      `INSERT INTO character_qa_runs
        (id, "characterId", "projectId", "characterContentVersionId", "projectVersion", "ownerId", status, checks, "evidenceHash")
       VALUES ($1, 'character', 'project', 'content', 1, 'owner', 'passed', '[]'::jsonb, $2)`,
      [qaRunId, `migration-rehearsal-qa-hash-${runId}-${databaseName}`],
    );
    let qaImmutableUpdateRejected = false;
    try {
      await db.query(
        `UPDATE character_qa_runs SET status = 'failed' WHERE id = $1`,
        [qaRunId],
      );
    } catch (error) {
      qaImmutableUpdateRejected = String(error).includes(
        "character_qa_runs are immutable",
      );
    }
    await db.query(`DELETE FROM character_qa_runs WHERE id = $1`, [qaRunId]);
    return {
      tables: tables.rows,
      triggers: triggers.rows,
      generationColumns: generationColumns.rows,
      servingConstraints: servingConstraints.rows,
      validatedServingConstraints: validatedServingConstraints.rows,
      migrationHistory: migrationHistory.rows,
      referenceSetActiveIndexes: referenceSetActiveIndexes.rows,
      publicQualificationAuthorityTriggers:
        publicQualificationAuthorityTriggers.rows,
      livePublicMediaAssetAuthorityTriggers:
        livePublicMediaAssetAuthorityTriggers.rows,
      accountDeletionAuthorityTriggers:
        accountDeletionAuthorityTriggers.rows,
      publicQualificationAuthority,
      localEvidenceTerminal,
      syntheticPreviewQuarantineForwardFix,
      runtimeSchemaReconciliation,
      checks: {
        migrationHistoryComplete: migrationHistoryAuthority.complete,
        migrationHistoryChecksumsMatch:
          migrationHistoryAuthority.checksumsMatch,
        expandedTablesPresent: tables.rowCount === 6,
        databaseGuardsPresent: triggers.rowCount === 6,
        qaImmutableUpdateRejected,
        servingConstraintsPresent:
          servingConstraints.rowCount === 3 &&
          servingConstraints.rows.every((row) => row.condeferrable === true),
        servingConstraintsValidateAfterBackfill:
          validatedServingConstraints.rowCount === 3 &&
          validatedServingConstraints.rows.every(
            (row) => row.convalidated === true,
          ),
        previousAppWriteShapeCompatible: generationColumns.rows.every(
          (column) =>
            column.is_nullable === "YES" || column.column_default !== null,
        ),
        accountDeletionAuthorityDeferred: (() => {
          const trigger = accountDeletionAuthorityTriggers.rows[0];
          return (
            accountDeletionAuthorityTriggers.rowCount === 1 &&
            trigger?.tgdeferrable === true &&
            trigger.tginitdeferred === true &&
            trigger.definition.includes("CREATE CONSTRAINT TRIGGER") &&
            trigger.definition.includes("INSERT") &&
            trigger.definition.includes("UPDATE")
          );
        })(),
        referenceSetSingleActiveIndexPresent:
          referenceSetActiveIndexes.rowCount === 1 &&
          referenceSetActiveIndexes.rows[0].indexdef.includes("WHERE") &&
          referenceSetActiveIndexes.rows[0].indexdef.includes("status") &&
          referenceSetActiveIndexes.rows[0].indexdef.includes("'active'::text"),
        duplicateActiveReferenceSetRejected,
        generationRunnerDefaultReconciled:
          runtimeSchemaReconciliation.runnerDefaultReconciled,
        retiredGenerationRunnerBackfilled:
          runtimeSchemaReconciliation.runnerBackfilled,
        retiredArtifactStateBackfilled:
          runtimeSchemaReconciliation.artifactStateBackfilled,
        malformedVisualProfileShadowRejected:
          runtimeSchemaReconciliation.malformedShadowRejected,
        malformedVisualProfileShadowRollbackPreserved:
          runtimeSchemaReconciliation.malformedShadowTransactionRolledBack,
        driftedVisualProfileShadowRejected:
          runtimeSchemaReconciliation.driftedShadowRejected,
        driftedVisualProfileShadowRollbackPreserved:
          runtimeSchemaReconciliation.driftedShadowTransactionRolledBack,
        visualProfileShadowAuthorityRemoved:
          runtimeSchemaReconciliation.visualProfileShadowRemoved,
        generationJobReferenceSnapshotPreserved:
          runtimeSchemaReconciliation.generationJobReferenceSnapshotPreserved,
        localEvidenceRowsTerminal: localEvidenceTerminal.targetRowsTerminal,
        localEvidencePayloadAndAttemptsPreserved:
          localEvidenceTerminal.targetEvidencePreserved,
        localEvidenceTerminalReasonRecorded:
          localEvidenceTerminal.terminalReasonRecorded &&
          localEvidenceTerminal.previousErrorPreserved,
        unrelatedOutboxRowPreserved:
          localEvidenceTerminal.unrelatedRowPreserved,
        localEvidenceTerminalMigrationIdempotent:
          localEvidenceTerminal.repeatedApplicationNoop,
        tolerantSyntheticPreviewQuarantined:
          syntheticPreviewQuarantineForwardFix.tolerantSyntheticValueQuarantined,
        unrelatedSyntheticMetadataPreserved:
          syntheticPreviewQuarantineForwardFix.unrelatedValuePreserved,
        syntheticPreviewForwardFixIdempotent:
          syntheticPreviewQuarantineForwardFix.repeatedApplicationNoop,
        publicQualificationAuthorityDeferred: (() => {
          const trigger = publicQualificationAuthorityTriggers.rows.find(
            (candidate) =>
              candidate.tgname === "public_catalog_qualification_authority",
          );
          return (
            trigger?.tgdeferrable === true &&
            trigger.tginitdeferred === true &&
            trigger.definition.includes("CREATE CONSTRAINT TRIGGER") &&
            trigger.definition.includes("DELETE")
          );
        })(),
        livePublicQualificationDeleteAuthorityDeferred: (() => {
          const trigger = publicQualificationAuthorityTriggers.rows.find(
            (candidate) =>
              candidate.tgname ===
              "live_public_authority_v2_from_qualification_delete",
          );
          return (
            trigger?.tgdeferrable === true &&
            trigger.tginitdeferred === true &&
            trigger.definition.includes("CREATE CONSTRAINT TRIGGER") &&
            trigger.definition.includes("DELETE")
          );
        })(),
        publicQualificationPolicyRouteAuthorityDeferred: (() => {
          const trigger = publicQualificationAuthorityTriggers.rows.find(
            (candidate) =>
              candidate.tgname ===
              "public_catalog_qualification_policy_route_authority",
          );
          return (
            trigger?.tgdeferrable === true &&
            trigger.tginitdeferred === true &&
            trigger.definition.includes("CREATE CONSTRAINT TRIGGER") &&
            trigger.definition.includes("INSERT")
          );
        })(),
        livePublicMediaAssetAuthorityCoversDelete: (() => {
          const trigger = livePublicMediaAssetAuthorityTriggers.rows[0];
          return (
            livePublicMediaAssetAuthorityTriggers.rowCount === 1 &&
            trigger?.tgdeferrable === true &&
            trigger.tginitdeferred === true &&
            trigger.definition.includes("CREATE CONSTRAINT TRIGGER") &&
            trigger.definition.includes("DELETE")
          );
        })(),
        qualificationCanPrecedeProjectionInOneTransaction:
          publicQualificationAuthority.committedAfterQualificationBeforeProjection,
        mismatchedQualificationRejectedAtCommit:
          publicQualificationAuthority.mismatchedQualification
            .statementsCompleted &&
          publicQualificationAuthority.mismatchedQualification.rejected,
        failedQualificationTransactionRolledBack:
          publicQualificationAuthority.failedQualificationRolledBack,
        missingGeneratedPolicyRejectedAtCommit:
          publicQualificationAuthority.missingPolicyAuthority
            .statementsCompleted &&
          publicQualificationAuthority.missingPolicyAuthority.rejected &&
          publicQualificationAuthority.missingPolicyAuthority.rolledBack,
        topLevelGeneratedRouteRejectedAtCommit:
          publicQualificationAuthority.topLevelRouteAuthority
            .statementsCompleted &&
          publicQualificationAuthority.topLevelRouteAuthority.rejected &&
          publicQualificationAuthority.topLevelRouteAuthority.rolledBack,
        livePublicMalformedManifestRejectedAtCommit:
          publicQualificationAuthority.missingLineageManifestAuthority
            .statementsCompleted &&
          publicQualificationAuthority.missingLineageManifestAuthority
            .rejected &&
          publicQualificationAuthority.missingLineageManifestAuthority
            .rolledBack,
        livePublicUnsafeSlotVersionRejectedAtCommit:
          publicQualificationAuthority.unsafeSlotVersionAuthority
            .statementsCompleted &&
          publicQualificationAuthority.unsafeSlotVersionAuthority.rejected &&
          publicQualificationAuthority.unsafeSlotVersionAuthority.rolledBack,
        livePublicTabOnlyLineageRejectedAtCommit:
          publicQualificationAuthority.tabOnlyLineageAuthority
            .statementsCompleted &&
          publicQualificationAuthority.tabOnlyLineageAuthority.rejected &&
          publicQualificationAuthority.tabOnlyLineageAuthority.rolledBack,
        livePublicHeroBlobAuthorityRejectedAtCommit:
          publicQualificationAuthority.unhydratableHeroAsset
            .statementsCompleted &&
          publicQualificationAuthority.unhydratableHeroAsset.rejected &&
          publicQualificationAuthority.unhydratableHeroAssetRolledBack,
        livePublicHeroVisibilityRejectedAtCommit:
          publicQualificationAuthority.privateHeroAsset.statementsCompleted &&
          publicQualificationAuthority.privateHeroAsset.rejected &&
          publicQualificationAuthority.privateHeroAssetRolledBack,
        livePublicChatBlockedRejectedAtCommit:
          publicQualificationAuthority.blockedChatAsset.statementsCompleted &&
          publicQualificationAuthority.blockedChatAsset.rejected &&
          publicQualificationAuthority.blockedChatAssetRolledBack,
        livePublicHeroDeleteRejectedAtCommit:
          publicQualificationAuthority.deletedHeroAsset.statementsCompleted &&
          publicQualificationAuthority.deletedHeroAsset.rejected &&
          publicQualificationAuthority.deletedHeroAssetRolledBack,
        secondaryDeleteAuthorityIndependentlyRejectsAtCommit:
          publicQualificationAuthority.secondaryDeleteActiveQualification
            .statementsCompleted &&
          publicQualificationAuthority.secondaryDeleteActiveQualification
            .rejected &&
          publicQualificationAuthority.secondaryDeleteRolledBack,
        activeQualificationDeleteRejectedAtCommit:
          publicQualificationAuthority.deleteActiveQualification
            .statementsCompleted &&
          publicQualificationAuthority.deleteActiveQualification.rejected,
        activeQualificationDeleteRolledBack:
          publicQualificationAuthority.activeQualificationDeleteRolledBack,
        qualificationImmutableAtCommit:
          publicQualificationAuthority.immutableUpdate.statementsCompleted &&
          publicQualificationAuthority.immutableUpdate.rejected &&
          publicQualificationAuthority.immutableEvidencePreserved,
        qualificationOneWayRevocation:
          publicQualificationAuthority.oneWayRevocationCommitted &&
          publicQualificationAuthority.unrevocation.statementsCompleted &&
          publicQualificationAuthority.unrevocation.rejected &&
          publicQualificationAuthority.revocationPreserved,
      },
    };
  } finally {
    await db.end();
  }
}

async function applyBaselineSnapshot(databaseName) {
  const baselineSql = await readFile(
    path.join(migrationsDirectory, baselineMigration, "migration.sql"),
    "utf8",
  );
  const db = new pg.Client({
    connectionString: databaseUrl(databaseName).toString(),
  });
  await db.connect();
  try {
    await db.query(baselineSql);
  } finally {
    await db.end();
  }
  runPrisma(databaseName, ["resolve", "--applied", baselineMigration]);
}

async function exercisePreviousAppWriteShape(databaseName) {
  const db = new pg.Client({
    connectionString: databaseUrl(databaseName).toString(),
  });
  await db.connect();
  try {
    const userId = `rehearsal-user-${runId}`;
    const jobId = `rehearsal-job-${runId}`;
    await db.query(
      `INSERT INTO users (id, email, "emailVerified", role, status, "updatedAt")
       VALUES ($1, $2, false, 'user', 'active', NOW())`,
      [userId, `${userId}@example.test`],
    );
    await db.query(
      `INSERT INTO generation_jobs
         (id, "userId", mode, controls, "presetIds", status, "updatedAt")
       VALUES ($1, $2, 'image', '{}'::jsonb, '[]'::jsonb, 'queued', NOW())`,
      [jobId, userId],
    );
    await db.query(
      `UPDATE generation_jobs
       SET status = 'failed', "errorCode" = 'legacy_app_rehearsal', "updatedAt" = NOW()
       WHERE id = $1`,
      [jobId],
    );
    const jobResult = await db.query(
      `SELECT status, "deliveredOutputCount", version
       FROM generation_jobs
       WHERE id = $1`,
      [jobId],
    );
    let rollbackSoftDeleteRejected = false;
    await db.query("BEGIN");
    try {
      await db.query(
        `UPDATE users
         SET status = 'deleted', "deletedAt" = NOW(), "updatedAt" = NOW()
         WHERE id = $1`,
        [userId],
      );
      await db.query(`DELETE FROM sessions WHERE "userId" = $1`, [userId]);
      await db.query("COMMIT");
    } catch (error) {
      rollbackSoftDeleteRejected =
        error?.code === "23514" &&
        error?.constraint === "customer_account_deletion_authority_required";
      await db.query("ROLLBACK");
    }
    const rollbackState = await db.query(
      `SELECT
         (SELECT status FROM users WHERE id = $1) AS user_status,
         (SELECT count(*)::integer FROM account_deletions WHERE "userId" = $1)
           AS deletion_count`,
      [userId],
    );

    const deletionId = `rehearsal-account-deletion-${runId}`;
    const deletionEventId = `user_deleted_${userId}`;
    await db.query("BEGIN");
    await db.query(
      `UPDATE users
       SET status = 'deleted', "deletedAt" = NOW(), "updatedAt" = NOW()
       WHERE id = $1`,
      [userId],
    );
    await db.query(
      `INSERT INTO account_deletions
        (id, "userId", "subjectHash", status, "requestedAt", "graceEndsAt",
         "chatRequestEventId", "updatedAt")
       VALUES (
         $1::text,
         $2::text,
         encode(sha256(convert_to($2::text, 'UTF8')), 'hex'),
         'awaiting_chat',
         NOW(),
         NOW() + INTERVAL '30 days',
         $3,
         NOW()
       )`,
      [deletionId, userId, deletionEventId],
    );
    await db.query(
      `INSERT INTO main_outbox_events
        (id, "eventType", "aggregateType", "aggregateId", payload, status,
         attempts, "nextRunAt", "createdAt", "updatedAt")
       SELECT
         $1,
         'user.account_deletion.requested.v2',
         'user',
         $2,
         jsonb_build_object(
           'sourceService', 'main',
           'sourceEventId', $1::text,
           'eventType', 'user.account_deletion.requested.v2',
           'schemaVersion', 2,
           'occurredAt', to_char(ad."requestedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'aggregateType', 'user',
           'aggregateId', $2::text,
           'payload', jsonb_build_object('userId', $2::text)
         ),
         'pending',
         0,
         ad."graceEndsAt",
         ad."requestedAt",
         NOW()
       FROM account_deletions ad
       WHERE ad.id = $3::text`,
      [deletionEventId, userId, deletionId],
    );
    await db.query("COMMIT");
    const currentDeletionState = await db.query(
      `SELECT
         u.status AS user_status,
         ad.status AS deletion_status,
         moe.status AS outbox_status,
         moe."eventType" AS outbox_event_type,
         moe.payload ->> 'eventType' AS envelope_event_type,
         (moe.payload ->> 'schemaVersion')::integer AS envelope_schema_version,
         moe."nextRunAt" = ad."graceEndsAt" AS due_time_matches
       FROM users u
       JOIN account_deletions ad ON ad."userId" = u.id
       JOIN main_outbox_events moe ON moe.id = ad."chatRequestEventId"
       WHERE u.id = $1`,
      [userId],
    );
    return {
      jobRow: jobResult.rows[0] ?? null,
      rollbackSoftDeleteRejected,
      rollbackState: rollbackState.rows[0] ?? null,
      currentDeletionState: currentDeletionState.rows[0] ?? null,
    };
  } finally {
    await db.end();
  }
}

const sourceMigrationHistory = await inspectMigrationHistory(
  sourceUrl.toString(),
);
if (process.argv.includes("--history-only")) {
  const report = {
    status:
      sourceMigrationHistory.complete && sourceMigrationHistory.checksumsMatch
        ? "pass"
        : "fail",
    sourceMigrationHistory,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.status === "pass" ? 0 : 1);
}

const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
try {
  await createDatabase(admin, freshDatabaseName);
  await createDatabase(admin, upgradeDatabaseName);

  const freshFirstDeploy = deploy(freshDatabaseName);
  const freshSecondDeploy = deploy(freshDatabaseName);
  const freshSchema = await inspectExpandedSchema(freshDatabaseName);

  await applyBaselineSnapshot(upgradeDatabaseName);
  const upgradeFirstDeploy = deploy(upgradeDatabaseName);
  const upgradeSecondDeploy = deploy(upgradeDatabaseName);
  const upgradeSchema = await inspectExpandedSchema(upgradeDatabaseName);

  // This is the application rollback leg: an older binary writes only the
  // baseline column set after the additive schema has landed.
  const previousAppWrite =
    await exercisePreviousAppWriteShape(upgradeDatabaseName);
  const previousAppRow = previousAppWrite.jobRow;
  // Re-deploying the current application/migrations proves the forward-fix leg
  // remains a no-op and preserves the old binary's durable write.
  const forwardFixDeploy = deploy(upgradeDatabaseName);
  const db = new pg.Client({
    connectionString: databaseUrl(upgradeDatabaseName).toString(),
  });
  await db.connect();
  const preservedPreviousAppRow = await db.query(
    `SELECT status, "deliveredOutputCount", version
     FROM generation_jobs
     WHERE id = $1`,
    [`rehearsal-job-${runId}`],
  );
  await db.end();

  const checks = {
    sourceMigrationHistoryComplete: sourceMigrationHistory.complete,
    sourceMigrationHistoryChecksumsMatch: sourceMigrationHistory.checksumsMatch,
    freshDeployAppliedEveryMigration:
      !freshFirstDeploy.includes("failed") &&
      freshSchema.checks.expandedTablesPresent,
    freshRedeployIsIdempotent: isNoopDeploy(freshSecondDeploy),
    currentSnapshotBaselineResolved:
      !upgradeFirstDeploy.includes(baselineMigration),
    currentSnapshotForwardDeployApplied:
      !upgradeFirstDeploy.includes("failed") &&
      upgradeSchema.checks.expandedTablesPresent,
    currentSnapshotRedeployIsIdempotent: isNoopDeploy(upgradeSecondDeploy),
    applicationRollbackWriteCompatible:
      previousAppRow?.status === "failed" &&
      previousAppRow.deliveredOutputCount === 0 &&
      previousAppRow.version === 1,
    rollbackSoftDeleteWithoutAuthorityRejected:
      previousAppWrite.rollbackSoftDeleteRejected === true &&
      previousAppWrite.rollbackState?.user_status === "active" &&
      previousAppWrite.rollbackState?.deletion_count === 0,
    currentAccountDeletionWriteAccepted:
      previousAppWrite.currentDeletionState?.user_status === "deleted" &&
      previousAppWrite.currentDeletionState?.deletion_status === "awaiting_chat" &&
      previousAppWrite.currentDeletionState?.outbox_status === "pending" &&
      previousAppWrite.currentDeletionState?.outbox_event_type ===
        "user.account_deletion.requested.v2" &&
      previousAppWrite.currentDeletionState?.envelope_event_type ===
        "user.account_deletion.requested.v2" &&
      previousAppWrite.currentDeletionState?.envelope_schema_version === 2 &&
      previousAppWrite.currentDeletionState?.due_time_matches === true,
    forwardFixRedeployIsIdempotent: isNoopDeploy(forwardFixDeploy),
    forwardFixPreservesRollbackWrite:
      preservedPreviousAppRow.rows[0]?.status === "failed" &&
      preservedPreviousAppRow.rows[0]?.deliveredOutputCount === 0 &&
      preservedPreviousAppRow.rows[0]?.version === 1,
    freshSchemaGuardsPass: Object.values(freshSchema.checks).every(Boolean),
    upgradedSchemaGuardsPass: Object.values(upgradeSchema.checks).every(
      Boolean,
    ),
  };
  const report = {
    status: Object.values(checks).every(Boolean) ? "pass" : "fail",
    scenarios: {
      source: {
        databaseName: sourceUrl.pathname.slice(1),
        migrationHistory: sourceMigrationHistory,
      },
      fresh: {
        databaseName: freshDatabaseName,
        schema: freshSchema,
      },
      currentSnapshotUpgrade: {
        databaseName: upgradeDatabaseName,
        baselineMigration,
        previousAppRow,
        previousAppWrite,
        preservedPreviousAppRow: preservedPreviousAppRow.rows[0] ?? null,
        schema: upgradeSchema,
      },
    },
    checks,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "pass") process.exitCode = 1;
} finally {
  await dropDatabase(admin, freshDatabaseName);
  await dropDatabase(admin, upgradeDatabaseName);
  await admin.end();
}
