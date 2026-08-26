import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  archiveSessionTx: vi.fn(async () => ({})),
  assertNoPendingChatFileMutationsTx: vi.fn(async () => {}),
  getRelationshipState: vi.fn(async () => ({ stage: "new", summary: "", version: 0 })),
  listRelationships: vi.fn(async () => []),
  lockUser: vi.fn(async () => {}),
  loggerError: vi.fn(),
  projectChatFileMutations: vi.fn(async () => {}),
  recordChatFileMutation: vi.fn(async () => "filemut-reset-1"),
  tx: {
    chatSession: {
      findMany: vi.fn(async () => [{ id: "session-1" }, { id: "session-2" }]),
    },
    chatUserView: {
      findUnique: vi.fn(async () => ({ userId: "user-1", status: "active", deletedAt: null })),
    },
  },
}));

vi.mock("./db.js", () => ({
  chatPrisma: {
    $transaction: async (run: (tx: typeof mocks.tx) => Promise<unknown>) => run(mocks.tx),
  },
}));

vi.mock("./file-mutations.js", () => ({
  CompanionProjectionClaimBusyError: class CompanionProjectionClaimBusyError extends Error {},
  assertNoPendingChatFileMutationsTx: mocks.assertNoPendingChatFileMutationsTx,
  projectChatFileMutations: mocks.projectChatFileMutations,
  recordChatFileMutation: mocks.recordChatFileMutation,
  runWithProjectedChatFiles: async (_userId: string, run: () => Promise<unknown>) => run(),
  withReadableChatFileSnapshot: async (_userId: string, read: () => Promise<unknown>) => read(),
}));

vi.mock("./service.js", () => ({
  archiveSession: vi.fn(),
  archiveSessionTx: mocks.archiveSessionTx,
  assertMessageStreamAccess: vi.fn(),
  confirmImageAttachment: vi.fn(),
  createSession: vi.fn(),
  editUserMessage: vi.fn(),
  getMessageVoiceAuthority: vi.fn(),
  getSession: vi.fn(),
  listSessions: vi.fn(),
  regenerate: vi.fn(),
  renameSession: vi.fn(),
  sendMessage: vi.fn(),
  setNoMemory: vi.fn(),
}));

vi.mock("./privacy.js", () => ({
  deleteMessage: vi.fn(),
  deleteSession: vi.fn(),
}));

vi.mock("./relationship.js", () => ({
  getRelationshipState: mocks.getRelationshipState,
  listRelationships: mocks.listRelationships,
}));

vi.mock("./logger.js", () => ({ logger: { error: mocks.loggerError } }));
vi.mock("./turn-lock.js", () => ({ lockUser: mocks.lockUser }));

const { dispatchChat } = await import("./router.js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("relationship API authority", () => {
  it("resets the relationship by archiving every active session and recording one reset intent", async () => {
    const response = await dispatchChat({
      method: "DELETE",
      path: "/api/v1/chat/relationships/character-1",
      userId: "user-1",
    });

    expect(response).toEqual({
      kind: "json",
      status: 200,
      body: { ok: true, archivedSessions: 2 },
    });
    expect(mocks.archiveSessionTx).toHaveBeenCalledTimes(2);
    expect(mocks.archiveSessionTx).toHaveBeenNthCalledWith(
      1,
      mocks.tx,
      { userId: "user-1", sessionId: "session-1" },
    );
    expect(mocks.recordChatFileMutation).toHaveBeenCalledOnce();
    expect(mocks.recordChatFileMutation).toHaveBeenCalledWith(
      mocks.tx,
      "user-1",
      { kind: "relationship_delete", characterId: "character-1" },
    );
    expect(mocks.projectChatFileMutations).toHaveBeenCalledWith("user-1");
  });

  it("rejects client-authored stage and summary without writing relationship authority", async () => {
    const response = await dispatchChat({
      method: "PATCH",
      path: "/api/v1/chat/relationships/character-1",
      userId: "user-1",
      body: { stage: "committed", summary: "The user says this is permanent." },
    });

    expect(response).toEqual({
      kind: "json",
      status: 405,
      body: { error: "method_not_allowed" },
    });
    expect(mocks.recordChatFileMutation).not.toHaveBeenCalled();
    expect(mocks.projectChatFileMutations).not.toHaveBeenCalled();
  });
});
