import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "../generated/client/client.js";
import type { ChatPrismaClient } from "./db.js";
import {
  claimNextProjectionTx,
  persistPreparedCompanionProjectionTx,
  promoteCompanionProjectionTx,
  projectChatFileMutations,
  type CompanionProjectionClaim,
} from "./file-mutations.js";
import { lockUser } from "./turn-lock.js";

const now = new Date("2026-08-20T12:00:00.000Z");

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function relationshipRebuildRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "filemut-rebuild-1",
    sequence: 7n,
    userId: "user-1",
    kind: "relationship_rebuild",
    payload: { kind: "relationship_rebuild", characterId: "character-1" },
    status: "pending",
    attempts: 0,
    lastError: null,
    projectionClaimToken: null,
    projectionClaimedAt: null,
    projectionAuthorityVersion: null,
    projectionRebuildId: null,
    createdAt: now,
    appliedAt: null,
    ...overrides,
  };
}

function claimTx(row = relationshipRebuildRow(), authorityVersion = 7n) {
  return {
    chatFileMutation: {
      findFirst: vi.fn(async () => row),
      findMany: vi.fn(async () => []),
      aggregate: vi.fn(async () => ({ _max: { sequence: authorityVersion } })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    chatSession: { findMany: vi.fn(async () => []) },
    message: { findMany: vi.fn(async () => []) },
    chatSendReceipt: { findMany: vi.fn(async () => []) },
  } as unknown as Prisma.TransactionClient;
}

describe("fenced companion projection claims", () => {
  it("reclaims an expired crash lease and binds the snapshot to current authority", async () => {
    const tx = claimTx(relationshipRebuildRow({
      projectionClaimToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      projectionClaimedAt: new Date(now.getTime() - 120_001),
      projectionAuthorityVersion: 6n,
    }), 9n);

    const step = await claimNextProjectionTx(tx, "user-1", {
      now,
      claimToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });

    expect(step).toMatchObject({
      kind: "companion",
      claim: {
        authorityVersion: 9n,
        fence: {
          mutationId: "filemut-rebuild-1",
          claimToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          authorityVersion: "9",
        },
        request: {
          scope: "relationship",
          userId: "user-1",
          characterId: "character-1",
          messages: [],
        },
      },
    });
    expect(tx.chatFileMutation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "filemut-rebuild-1",
        OR: expect.arrayContaining([
          { projectionClaimedAt: { lt: new Date(now.getTime() - 120_000) } },
        ]),
      }),
      data: expect.objectContaining({ projectionAuthorityVersion: 9n }),
    }));
  });

  it("does not steal a live lease", async () => {
    const tx = claimTx(relationshipRebuildRow({
      projectionClaimToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      projectionClaimedAt: new Date(now.getTime() - 119_999),
      projectionAuthorityVersion: 7n,
    }));

    await expect(claimNextProjectionTx(tx, "user-1", { now }))
      .rejects.toThrow(/live projection claim/);
    expect(tx.chatFileMutation.aggregate).not.toHaveBeenCalled();
  });

  it("resumes a persisted crash candidate with the original fence instead of minting a stale one", async () => {
    const tx = claimTx(relationshipRebuildRow({
      projectionClaimToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      projectionClaimedAt: new Date(now.getTime() - 120_001),
      projectionAuthorityVersion: 9n,
      projectionRebuildId: "11111111-1111-4111-8111-111111111111",
    }), 9n);

    const step = await claimNextProjectionTx(tx, "user-1", {
      now,
      claimToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });

    expect(step).toMatchObject({
      kind: "companion",
      claim: {
        claimToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        rebuildId: "11111111-1111-4111-8111-111111111111",
        fence: {
          claimToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          authorityVersion: "9",
        },
      },
    });
    expect((step as { claim: { request?: unknown } }).claim.request).toBeUndefined();
    expect(tx.chatSession.findMany).not.toHaveBeenCalled();
  });

  it("refuses candidate persistence when authority advanced during the external build", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
      chatFileMutation: {
        aggregate: vi.fn(async () => ({ _max: { sequence: 10n } })),
        updateMany,
      },
    } as unknown as Prisma.TransactionClient;
    const claim: CompanionProjectionClaim = {
      mutationId: "filemut-rebuild-1",
      userId: "user-1",
      characterId: "character-1",
      claimToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      authorityVersion: 9n,
      fence: {
        mutationId: "filemut-rebuild-1",
        claimToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        authorityVersion: "9",
      },
      request: {
        scope: "relationship",
        userId: "user-1",
        characterId: "character-1",
        messages: [],
        fence: {
          mutationId: "filemut-rebuild-1",
          claimToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          authorityVersion: "9",
        },
      },
    };

    await expect(persistPreparedCompanionProjectionTx(
      tx,
      claim,
      "11111111-1111-4111-8111-111111111111",
    )).resolves.toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("rejects a prepared candidate when a concurrent writer commits first", async () => {
    let authorityVersion = 9n;
    let lockOwner: symbol | undefined;
    const waiters: Array<() => void> = [];
    const transaction = async <T>(
      run: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> => {
      const owner = Symbol("transaction");
      const tx = {
        $queryRaw: vi.fn(async () => {
          while (lockOwner && lockOwner !== owner) {
            await new Promise<void>((resolve) => waiters.push(resolve));
          }
          lockOwner = owner;
          return [{ locked: 1 }];
        }),
        chatFileMutation: {
          aggregate: vi.fn(async () => ({ _max: { sequence: authorityVersion } })),
          count: vi.fn(async () => 1),
        },
      } as unknown as Prisma.TransactionClient;
      try {
        return await run(tx);
      } finally {
        if (lockOwner === owner) {
          lockOwner = undefined;
          waiters.shift()?.();
        }
      }
    };
    const writerEntered = deferred();
    const releaseWriter = deferred();
    const writer = transaction(async (tx) => {
      await lockUser(tx, "user-1");
      authorityVersion = 10n;
      writerEntered.resolve();
      await releaseWriter.promise;
    });
    await writerEntered.promise;

    const promote = vi.fn(async () => undefined);
    const projection = transaction((tx) => promoteCompanionProjectionTx(
      tx,
      companionClaim(),
      "11111111-1111-4111-8111-111111111111",
      promote,
    ));
    releaseWriter.resolve();

    await expect(projection).resolves.toBe(false);
    await writer;
    expect(promote).not.toHaveBeenCalled();
  });

  it("holds the user fence through bounded promotion so a concurrent writer enters afterward", async () => {
    let lockOwner: symbol | undefined;
    const waiters: Array<() => void> = [];
    const transaction = async <T>(
      run: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> => {
      const owner = Symbol("transaction");
      const tx = {
        $queryRaw: vi.fn(async () => {
          while (lockOwner && lockOwner !== owner) {
            await new Promise<void>((resolve) => waiters.push(resolve));
          }
          lockOwner = owner;
          return [{ locked: 1 }];
        }),
        chatFileMutation: {
          aggregate: vi.fn(async () => ({ _max: { sequence: 9n } })),
          count: vi.fn(async () => 1),
        },
      } as unknown as Prisma.TransactionClient;
      try {
        return await run(tx);
      } finally {
        if (lockOwner === owner) {
          lockOwner = undefined;
          waiters.shift()?.();
        }
      }
    };
    const promoteEntered = deferred();
    const releasePromote = deferred();
    const projection = transaction((tx) => promoteCompanionProjectionTx(
      tx,
      companionClaim(),
      "11111111-1111-4111-8111-111111111111",
      async () => {
        promoteEntered.resolve();
        await releasePromote.promise;
      },
    ));
    await promoteEntered.promise;

    let writerEntered = false;
    const writer = transaction(async (tx) => {
      await lockUser(tx, "user-1");
      writerEntered = true;
    });
    await Promise.resolve();
    expect(writerEntered).toBe(false);
    releasePromote.resolve();

    await expect(projection).resolves.toBe(true);
    await writer;
    expect(writerEntered).toBe(true);
  });

  it("holds no interactive transaction across prepare and discards a stale candidate", async () => {
    let inTransaction = false;
    let cleared = false;
    let aggregateCalls = 0;
    const row = relationshipRebuildRow();
    const tx = {
      $queryRaw: vi.fn(async () => [{ locked: 1 }]),
      chatFileMutation: {
        findFirst: vi.fn(async () => cleared ? null : row),
        findMany: vi.fn(async () => []),
        aggregate: vi.fn(async () => ({
          _max: { sequence: aggregateCalls++ === 0 ? 7n : 8n },
        })),
        updateMany: vi.fn(async (input: { data?: { projectionClaimToken?: string | null } }) => {
          if (input.data?.projectionClaimToken === null) cleared = true;
          return { count: 1 };
        }),
      },
      chatSession: { findMany: vi.fn(async () => []) },
      message: { findMany: vi.fn(async () => []) },
      chatSendReceipt: { findMany: vi.fn(async () => []) },
    } as unknown as Prisma.TransactionClient;
    const prisma = {
      ...tx,
      $transaction: vi.fn(async (run: (client: Prisma.TransactionClient) => Promise<unknown>) => {
        expect(inTransaction).toBe(false);
        inTransaction = true;
        try {
          return await run(tx);
        } finally {
          inTransaction = false;
        }
      }),
    } as unknown as ChatPrismaClient;
    const prepare = vi.fn(async () => {
      expect(inTransaction).toBe(false);
      return {
        rebuildId: "11111111-1111-4111-8111-111111111111",
        sessions: 0,
        messages: 0,
      };
    });
    const promote = vi.fn(async () => {
      throw new Error("stale authority must not promote");
    });
    const discard = vi.fn(async () => {
      expect(inTransaction).toBe(false);
    });
    const applyLocal = vi.fn(async () => {
      expect(inTransaction).toBe(false);
    });

    await expect(projectChatFileMutations("user-1", prisma, {
      purge: vi.fn(async () => ({})),
      prepare,
      promote,
      discard,
    }, applyLocal)).resolves.toBe(0);
    expect(applyLocal).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledOnce();
    expect(promote).not.toHaveBeenCalled();
  });
});

function companionClaim(): CompanionProjectionClaim {
  return {
    mutationId: "filemut-rebuild-1",
    userId: "user-1",
    characterId: "character-1",
    claimToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    authorityVersion: 9n,
    fence: {
      mutationId: "filemut-rebuild-1",
      claimToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      authorityVersion: "9",
    },
  };
}
