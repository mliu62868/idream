import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as reconcileMutationReceipt } from "@/app/api/v2/admin/mutation-receipts/reconcile/route";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { canonicalSha256 } from "./canonical-json";
import { executeAtomicIdempotentMutation } from "./atomic-mutation";
import { createUser } from "@/server/test/helpers";

describe("Admin mutation receipt recovery authority", () => {
  const suffix = randomUUID();
  const actorId = `mutation-recovery-admin-${suffix}`;
  const otherActorId = `mutation-recovery-other-${suffix}`;
  const limitedActorId = `mutation-recovery-limited-${suffix}`;
  const deniedActorId = `mutation-recovery-denied-${suffix}`;
  const scopedActorId = `mutation-recovery-scoped-${suffix}`;
  const scopedCharacterId = `mutation-recovery-character-${suffix}`;
  const otherScopedCharacterId =
    `mutation-recovery-character-other-${suffix}`;
  const deniedCharacterId =
    `mutation-recovery-character-denied-${suffix}`;

  function request(input: {
    actorId?: string;
    role?: "admin" | "user";
    commandType:
      | "creative.run.create"
      | "character.project.create"
      | "creative.review.decision"
      | "character.identity.bootstrap"
      | "character.project.draft_image.select";
    idempotencyKey: string;
    expectedCharacterId?: string;
    expectedPurpose?:
      | "character_cover"
      | "character_hero"
      | "character_chat";
  }) {
    return new Request(
      "http://localhost/api/v2/admin/mutation-receipts/reconcile",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": input.idempotencyKey,
          "x-idream-user-id": input.actorId ?? actorId,
          "x-idream-role": input.role ?? "admin",
          "x-request-id": randomUUID(),
        },
        body: JSON.stringify({
          commandType: input.commandType,
          ...(input.expectedCharacterId
            ? {
                expectedCharacterId:
                  input.expectedCharacterId,
              }
            : {}),
          ...(input.expectedPurpose
            ? { expectedPurpose: input.expectedPurpose }
            : {}),
        }),
      },
    );
  }

  beforeAll(async () => {
    await createUser({
      id: actorId,
      role: "admin",
      dataClass: "internal",
    });
    await createUser({
      id: otherActorId,
      role: "admin",
      dataClass: "internal",
    });
    await createUser({
      id: limitedActorId,
      role: "user",
      dataClass: "internal",
    });
    await createUser({
      id: deniedActorId,
      role: "user",
      dataClass: "internal",
    });
    await createUser({
      id: scopedActorId,
      role: "user",
      dataClass: "internal",
    });
    await prisma.adminUserPermission.create({
      data: {
        userId: limitedActorId,
        permissionKey: "creative.run.review",
        effect: "grant",
        reason: "Exercise minimum receipt-recovery authority",
        createdById: actorId,
      },
    });
    await prisma.adminUserGrantBundle.create({
      data: {
        userId: scopedActorId,
        bundleKey: "character_producer",
        scope: {
          characterIds: [
            scopedCharacterId,
            otherScopedCharacterId,
          ],
        },
        reason:
          "Exercise Character-scoped mutation receipt recovery",
        createdById: actorId,
      },
    });
  });

  afterAll(async () => {
    const actorIds = [
      actorId,
      otherActorId,
      limitedActorId,
      deniedActorId,
      scopedActorId,
    ];
    await prisma.adminAuditLog.deleteMany({
      where: { actorId: { in: actorIds } },
    });
    await prisma.controlPlaneCommand.deleteMany({
      where: { actorId: { in: actorIds } },
    });
    await prisma.adminUserPermission.deleteMany({
      where: { userId: { in: actorIds } },
    });
    await prisma.adminUserGrantBundle.deleteMany({
      where: { userId: { in: actorIds } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: actorIds } },
    });
    await prisma.$disconnect();
  });

  it("returns the committed target from the existing receipt without adding a tombstone", async () => {
    const idempotencyKey = `committed-${suffix}`;
    const commandId = randomUUID();
    const runId = randomUUID();
    const itemId = randomUUID();
    const decisionId = randomUUID();
    await prisma.controlPlaneCommand.create({
      data: {
        id: commandId,
        scope: `${env.APP_ENV}:${actorId}`,
        idempotencyKey,
        commandType: "creative.review.decision",
        targetType: "creative_run_item",
        targetId: itemId,
        actorId,
        requestId: randomUUID(),
        requestHash: canonicalSha256({ commandId }),
        requestPayload: {
          runId,
          entityVersion: 1,
          decision: "approved",
          identityConsistency: "passed",
          score: 91,
          quality: {
            anatomy: true,
            composition: true,
            singleSubject: true,
            intentMatch: true,
            noVisibleText: true,
          },
          reason: "Exact candidate evidence passed",
        },
        retryMode: "idempotent",
        status: "succeeded",
        result: {
          runId,
          itemId,
          decisionId,
          decision: "approved",
          workflowStage: "reviewed",
          version: 2,
        },
        finishedAt: new Date(),
      },
    });

    const response = await reconcileMutationReceipt(request({
      commandType: "creative.review.decision",
      idempotencyKey,
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        state: "committed",
        commandType: "creative.review.decision",
        commandId,
        status: "succeeded",
        committedTargetId: decisionId,
        verification: {
          kind: "creative_review_decision",
          runId,
          itemId,
          decisionId,
          requestSnapshot: {
            runId,
            itemId,
          },
        },
      },
    });
    expect(await prisma.controlPlaneCommand.count({
      where: { actorId, idempotencyKey },
    })).toBe(1);
    expect(await prisma.adminAuditLog.count({
      where: {
        actorId,
        action: "admin.mutation_recovery.cancelled",
        targetId: commandId,
      },
    })).toBe(0);
  });

  it("binds recovered Character Run receipts to the persisted target and purpose", async () => {
    const idempotencyKey = `character-run-${suffix}`;
    const commandId = randomUUID();
    const runId = randomUUID();
    const requestPayload = {
      title: "Recovered Character hero",
      purpose: "character_hero",
      targetType: "character",
      targetId: scopedCharacterId,
      profileId: "profile-1",
      presetIds: [],
      referenceAssetIds: ["reference-1"],
      bootstrapIdentity: false,
      orientation: "16:9",
      count: 4,
      brief: "Preserve the exact Character identity.",
      consistencyMode: "strict",
      priority: "normal",
      reason: "Recover the exact committed Character Run",
    };
    await prisma.controlPlaneCommand.create({
      data: {
        id: commandId,
        scope:
          `${env.APP_ENV}:${actorId}:creative.run.create`,
        idempotencyKey,
        commandType: "creative.run.create",
        targetType: "creative_run",
        targetId: runId,
        actorId,
        requestId: randomUUID(),
        requestHash: canonicalSha256({ commandId }),
        requestPayload,
        retryMode: "idempotent",
        status: "succeeded",
        result: { batchId: runId },
        finishedAt: new Date(),
      },
    });

    const wrongCharacter = await reconcileMutationReceipt(request({
      commandType: "creative.run.create",
      idempotencyKey,
      expectedCharacterId: otherScopedCharacterId,
      expectedPurpose: "character_hero",
    }));
    expect(wrongCharacter.status).toBe(409);

    const wrongPurpose = await reconcileMutationReceipt(request({
      commandType: "creative.run.create",
      idempotencyKey,
      expectedCharacterId: scopedCharacterId,
      expectedPurpose: "character_chat",
    }));
    expect(wrongPurpose.status).toBe(409);

    const matching = await reconcileMutationReceipt(request({
      commandType: "creative.run.create",
      idempotencyKey,
      expectedCharacterId: scopedCharacterId,
      expectedPurpose: "character_hero",
    }));
    expect(matching.status).toBe(200);
    expect(await matching.json()).toMatchObject({
      data: {
        state: "committed",
        committedTargetId: runId,
        verification: {
          kind: "creative_run",
          runId,
          requestSnapshot: requestPayload,
        },
      },
    });
  });

  it("lets the reconciliation tombstone win and blocks a late domain mutation", async () => {
    const idempotencyKey = `tombstone-${suffix}`;
    const recovery = await reconcileMutationReceipt(request({
      commandType: "creative.review.decision",
      idempotencyKey,
    }));
    expect(recovery.status).toBe(200);
    expect(await recovery.json()).toMatchObject({
      data: {
        state: "cancelled",
        commandType: "creative.review.decision",
        status: "cancelled",
        committedTargetId: null,
        verification: null,
      },
    });

    let mutationRan = false;
    await expect(executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor: { id: actorId, role: "admin" },
      idempotencyKey,
      requestId: randomUUID(),
      commandType: "creative.review.decision",
      target: { type: "creative_run_item", id: randomUUID() },
      expectedVersion: 1,
      payload: { decision: "approved" },
      mutate: async () => {
        mutationRan = true;
        return { decisionId: randomUUID() };
      },
    })).rejects.toMatchObject({
      code: "conflict",
      status: 409,
    });
    expect(mutationRan).toBe(false);
    expect(await prisma.controlPlaneCommand.count({
      where: { actorId, idempotencyKey },
    })).toBe(1);
  });

  it("converges concurrent reconciliation requests onto one tombstone", async () => {
    const idempotencyKey = `concurrent-recovery-${suffix}`;
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        reconcileMutationReceipt(request({
          commandType: "creative.review.decision",
          idempotencyKey,
        }))),
    );

    expect(responses.map((response) => response.status)).toEqual([
      200,
      200,
      200,
      200,
    ]);
    const payloads = await Promise.all(
      responses.map(async (response) => response.json()),
    );
    expect(new Set(payloads.map((payload) => payload.data.commandId)).size).toBe(
      1,
    );
    expect(await prisma.controlPlaneCommand.count({
      where: { actorId, idempotencyKey },
    })).toBe(1);
    expect(await prisma.adminAuditLog.count({
      where: {
        actorId,
        action: "admin.mutation_recovery.cancelled",
        targetId: payloads[0].data.commandId,
      },
    })).toBe(1);
  });

  it("converges concurrent atomic mutations onto one committed result", async () => {
    const idempotencyKey = `concurrent-atomic-${suffix}`;
    const targetId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        executeAtomicIdempotentMutation({
          environment: env.APP_ENV,
          actor: { id: actorId, role: "admin" },
          idempotencyKey,
          requestId: randomUUID(),
          commandType: "test.atomic.concurrent",
          target: { type: "test_target", id: targetId },
          payload: { targetId },
          mutate: async () => {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 30);
            });
            return { operationId: randomUUID(), targetId };
          },
        })),
    );

    expect(results).toEqual(Array.from({ length: 4 }, () => results[0]));
    expect(await prisma.controlPlaneCommand.count({
      where: { actorId, idempotencyKey },
    })).toBe(1);
  });

  it("isolates the same receipt key by actor", async () => {
    const idempotencyKey = `actor-isolation-${suffix}`;
    const [first, second] = await Promise.all([
      reconcileMutationReceipt(request({
        commandType: "creative.review.decision",
        idempotencyKey,
      })),
      reconcileMutationReceipt(request({
        actorId: otherActorId,
        commandType: "creative.review.decision",
        idempotencyKey,
      })),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await prisma.controlPlaneCommand.count({
      where: {
        actorId: { in: [actorId, otherActorId] },
        idempotencyKey,
      },
    })).toBe(2);
    expect(await prisma.controlPlaneCommand.findMany({
      where: { idempotencyKey },
      select: { scope: true },
      orderBy: { scope: "asc" },
    })).toEqual([
      { scope: `${env.APP_ENV}:${actorId}` },
      { scope: `${env.APP_ENV}:${otherActorId}` },
    ].sort((left, right) => left.scope.localeCompare(right.scope)));
  });

  it("rejects a key already bound to another mutation type in the same scope", async () => {
    const idempotencyKey = `wrong-type-${suffix}`;
    const first = await reconcileMutationReceipt(request({
      commandType: "creative.review.decision",
      idempotencyKey,
    }));
    expect(first.status).toBe(200);

    const conflict = await reconcileMutationReceipt(request({
      commandType: "character.identity.bootstrap",
      idempotencyKey,
      expectedCharacterId: scopedCharacterId,
    }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: {
        code: "conflict",
        details: {
          expectedCommandType: "character.identity.bootstrap",
          existingCommandType: "creative.review.decision",
        },
      },
    });
    expect(await prisma.controlPlaneCommand.count({
      where: { actorId, idempotencyKey },
    })).toBe(1);
  });

  it("requires only the original mutation permission and denies an actor without it", async () => {
    const allowed = await reconcileMutationReceipt(request({
      actorId: limitedActorId,
      role: "user",
      commandType: "creative.review.decision",
      idempotencyKey: `limited-allowed-${suffix}`,
    }));
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({
      data: {
        state: "cancelled",
        commandType: "creative.review.decision",
      },
    });

    const denied = await reconcileMutationReceipt(request({
      actorId: deniedActorId,
      role: "user",
      commandType: "creative.review.decision",
      idempotencyKey: `limited-denied-${suffix}`,
    }));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      error: {
        code: "forbidden",
        details: { permission: "creative.run.review" },
      },
    });
  });

  it("enforces the Character grant scope before writing a no-receipt tombstone", async () => {
    const allowedKey = `scoped-allowed-${suffix}`;
    const allowed = await reconcileMutationReceipt(request({
      actorId: scopedActorId,
      role: "user",
      commandType:
        "character.project.draft_image.select",
      idempotencyKey: allowedKey,
      expectedCharacterId: scopedCharacterId,
    }));
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({
      data: {
        state: "cancelled",
        commandType:
          "character.project.draft_image.select",
        verification: null,
      },
    });
    expect(await prisma.controlPlaneCommand.findUniqueOrThrow({
      where: {
        scope_idempotencyKey: {
          scope: `${env.APP_ENV}:${scopedActorId}`,
          idempotencyKey: allowedKey,
        },
      },
    })).toMatchObject({
      actorId: scopedActorId,
      targetType: "character",
      targetId: scopedCharacterId,
      status: "cancelled",
      requestPayload: {
        recovery: "cancelled_unreplayable_snapshot",
        expectedCharacterId: scopedCharacterId,
      },
    });

    const deniedKey = `scoped-denied-${suffix}`;
    const denied = await reconcileMutationReceipt(request({
      actorId: scopedActorId,
      role: "user",
      commandType:
        "character.project.draft_image.select",
      idempotencyKey: deniedKey,
      expectedCharacterId: deniedCharacterId,
    }));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      error: {
        code: "forbidden",
        details: {
          permission: "character.project.write",
          characterId: deniedCharacterId,
        },
      },
    });
    expect(await prisma.controlPlaneCommand.count({
      where: {
        actorId: scopedActorId,
        idempotencyKey: deniedKey,
      },
    })).toBe(0);
    expect(await prisma.adminAuditLog.count({
      where: {
        actorId: scopedActorId,
        action: "admin.mutation_recovery.cancelled",
        requestId: {
          not: null,
        },
        after: {
          path: ["expectedCharacterId"],
          equals: deniedCharacterId,
        },
      },
    })).toBe(0);
  });

  it("checks the trusted receipt Character scope instead of trusting only the client expectation", async () => {
    const idempotencyKey = `trusted-scope-denied-${suffix}`;
    const commandId = randomUUID();
    await prisma.controlPlaneCommand.create({
      data: {
        id: commandId,
        scope: `${env.APP_ENV}:${scopedActorId}`,
        idempotencyKey,
        commandType: "character.identity.bootstrap",
        targetType: "character",
        targetId: deniedCharacterId,
        actorId: scopedActorId,
        requestId: randomUUID(),
        requestHash: canonicalSha256({ commandId }),
        requestPayload: {
          entityVersion: 1,
          runId: randomUUID(),
          itemId: randomUUID(),
        },
        retryMode: "idempotent",
        status: "accepted",
      },
    });

    const response = await reconcileMutationReceipt(request({
      actorId: scopedActorId,
      role: "user",
      commandType: "character.identity.bootstrap",
      idempotencyKey,
      expectedCharacterId: scopedCharacterId,
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: {
        code: "forbidden",
        details: {
          permission: "character.project.write",
          characterId: deniedCharacterId,
        },
      },
    });
    expect(await prisma.controlPlaneCommand.findUniqueOrThrow({
      where: { id: commandId },
    })).toMatchObject({
      status: "accepted",
      targetId: deniedCharacterId,
    });
  });

  it("rejects a trusted Character target or result that does not match the expected resource", async () => {
    const targetMismatchKey = `target-mismatch-${suffix}`;
    const targetMismatchCommandId = randomUUID();
    await prisma.controlPlaneCommand.create({
      data: {
        id: targetMismatchCommandId,
        scope: `${env.APP_ENV}:${scopedActorId}`,
        idempotencyKey: targetMismatchKey,
        commandType: "character.identity.bootstrap",
        targetType: "character",
        targetId: scopedCharacterId,
        actorId: scopedActorId,
        requestId: randomUUID(),
        requestHash: canonicalSha256({
          targetMismatchCommandId,
        }),
        requestPayload: {},
        retryMode: "idempotent",
        status: "succeeded",
        result: {
          characterId: scopedCharacterId,
          referenceSetRevisionId: randomUUID(),
          anchorAssetId: randomUUID(),
          draftImageAssetId: randomUUID(),
        },
        finishedAt: new Date(),
      },
    });
    const targetMismatch = await reconcileMutationReceipt(request({
      actorId: scopedActorId,
      role: "user",
      commandType: "character.identity.bootstrap",
      idempotencyKey: targetMismatchKey,
      expectedCharacterId: otherScopedCharacterId,
    }));
    expect(targetMismatch.status).toBe(409);
    expect(await targetMismatch.json()).toMatchObject({
      error: {
        code: "conflict",
        message:
          "Mutation receipt does not match the expected Character resource",
        details: {
          commandType: "character.identity.bootstrap",
        },
      },
    });

    const resultMismatchKey = `result-mismatch-${suffix}`;
    const resultMismatchCommandId = randomUUID();
    await prisma.controlPlaneCommand.create({
      data: {
        id: resultMismatchCommandId,
        scope: `${env.APP_ENV}:${scopedActorId}`,
        idempotencyKey: resultMismatchKey,
        commandType:
          "character.project.draft_image.select",
        targetType: "character",
        targetId: scopedCharacterId,
        actorId: scopedActorId,
        requestId: randomUUID(),
        requestHash: canonicalSha256({
          resultMismatchCommandId,
        }),
        requestPayload: {},
        retryMode: "idempotent",
        status: "succeeded",
        result: {
          characterId: otherScopedCharacterId,
          selectedPurpose: "character_cover",
          selectedAssetId: randomUUID(),
        },
        finishedAt: new Date(),
      },
    });
    const resultMismatch = await reconcileMutationReceipt(request({
      actorId: scopedActorId,
      role: "user",
      commandType:
        "character.project.draft_image.select",
      idempotencyKey: resultMismatchKey,
      expectedCharacterId: scopedCharacterId,
    }));
    expect(resultMismatch.status).toBe(409);
    expect(await resultMismatch.json()).toMatchObject({
      error: {
        code: "conflict",
        message:
          "Mutation receipt does not match the expected Character resource",
      },
    });
  });

  it("returns typed Character projection evidence only from a bound succeeded receipt", async () => {
    const bootstrapKey = `typed-bootstrap-${suffix}`;
    const bootstrapCommandId = randomUUID();
    const referenceSetRevisionId = randomUUID();
    const anchorAssetId = randomUUID();
    const draftImageAssetId = randomUUID();
    await prisma.controlPlaneCommand.create({
      data: {
        id: bootstrapCommandId,
        scope: `${env.APP_ENV}:${scopedActorId}`,
        idempotencyKey: bootstrapKey,
        commandType: "character.identity.bootstrap",
        targetType: "character",
        targetId: scopedCharacterId,
        actorId: scopedActorId,
        requestId: randomUUID(),
        requestHash: canonicalSha256({
          bootstrapCommandId,
        }),
        requestPayload: {},
        retryMode: "idempotent",
        status: "succeeded",
        result: {
          characterId: scopedCharacterId,
          referenceSetRevisionId,
          anchorAssetId,
          draftImageAssetId,
        },
        finishedAt: new Date(),
      },
    });
    const bootstrap = await reconcileMutationReceipt(request({
      actorId: scopedActorId,
      role: "user",
      commandType: "character.identity.bootstrap",
      idempotencyKey: bootstrapKey,
      expectedCharacterId: scopedCharacterId,
    }));
    expect(bootstrap.status).toBe(200);
    expect(await bootstrap.json()).toMatchObject({
      data: {
        state: "committed",
        committedTargetId: referenceSetRevisionId,
        verification: {
          kind: "character_identity_bootstrap",
          characterId: scopedCharacterId,
          referenceSetRevisionId,
          anchorAssetId,
          draftImageAssetId,
        },
      },
    });

    const selectionKey = `typed-selection-${suffix}`;
    const selectionCommandId = randomUUID();
    const selectedAssetId = randomUUID();
    await prisma.controlPlaneCommand.create({
      data: {
        id: selectionCommandId,
        scope: `${env.APP_ENV}:${scopedActorId}`,
        idempotencyKey: selectionKey,
        commandType:
          "character.project.draft_image.select",
        targetType: "character",
        targetId: scopedCharacterId,
        actorId: scopedActorId,
        requestId: randomUUID(),
        requestHash: canonicalSha256({
          selectionCommandId,
        }),
        requestPayload: {},
        retryMode: "idempotent",
        status: "succeeded",
        result: {
          characterId: scopedCharacterId,
          selectedPurpose: "character_hero",
          selectedAssetId,
        },
        finishedAt: new Date(),
      },
    });
    const selection = await reconcileMutationReceipt(request({
      actorId: scopedActorId,
      role: "user",
      commandType:
        "character.project.draft_image.select",
      idempotencyKey: selectionKey,
      expectedCharacterId: scopedCharacterId,
    }));
    expect(selection.status).toBe(200);
    expect(await selection.json()).toMatchObject({
      data: {
        state: "committed",
        committedTargetId: selectedAssetId,
        verification: {
          kind: "character_draft_image_selection",
          characterId: scopedCharacterId,
          selectedPurpose: "character_hero",
          selectedAssetId,
        },
      },
    });
  });

  it("reveals a legacy Character tombstone type only after scoped authorization and then replays its cancellation", async () => {
    const idempotencyKey = `legacy-tombstone-${suffix}`;
    const commandId = randomUUID();
    await prisma.controlPlaneCommand.create({
      data: {
        id: commandId,
        scope: `${env.APP_ENV}:${scopedActorId}`,
        idempotencyKey,
        commandType:
          "character.project.draft_image.select",
        targetType: "character_project",
        targetId: "uncommitted",
        actorId: scopedActorId,
        requestId: randomUUID(),
        requestHash: canonicalSha256({ commandId }),
        requestPayload: {
          recovery: "cancelled_unreplayable_snapshot",
        },
        retryMode: "idempotent",
        status: "cancelled",
        result: { recoveryState: "cancelled" },
        error: {
          code: "unreplayable_client_snapshot",
          message: "Legacy recovery tombstone",
        },
        finishedAt: new Date(),
      },
    });

    const wrongType = await reconcileMutationReceipt(request({
      actorId: scopedActorId,
      role: "user",
      commandType: "character.identity.bootstrap",
      idempotencyKey,
      expectedCharacterId: scopedCharacterId,
    }));
    expect(wrongType.status).toBe(409);
    expect(await wrongType.json()).toMatchObject({
      error: {
        code: "conflict",
        details: {
          expectedCommandType: "character.identity.bootstrap",
          existingCommandType:
            "character.project.draft_image.select",
        },
      },
    });

    const response = await reconcileMutationReceipt(request({
      actorId: scopedActorId,
      role: "user",
      commandType:
        "character.project.draft_image.select",
      idempotencyKey,
      expectedCharacterId: scopedCharacterId,
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        state: "cancelled",
        commandId,
        commandType:
          "character.project.draft_image.select",
        committedTargetId: null,
        verification: null,
      },
    });
    expect(await prisma.controlPlaneCommand.count({
      where: {
        actorId: scopedActorId,
        idempotencyKey,
      },
    })).toBe(1);
    expect(await prisma.adminAuditLog.count({
      where: {
        actorId: scopedActorId,
        action: "admin.mutation_recovery.cancelled",
        targetId: commandId,
      },
    })).toBe(0);
  });
});
