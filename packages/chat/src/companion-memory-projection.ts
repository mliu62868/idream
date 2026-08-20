import {
  companionWorkspaceRebuildSchema,
  type CompanionWorkspaceRebuild,
  type CompanionWorkspaceRebuildMessage,
} from "@idream/shared/chat/companion-runtime";
import type { Prisma } from "../generated/client/client.js";
import { env } from "./env.js";
import {
  purgeCompanionWorkspace,
  rebuildCompanionWorkspace,
  type CompanionWorkspacePurgeTarget,
} from "./companion-runtime.js";
import {
  loadSessionLinkage,
  type RelationshipLinkage,
  type RelationshipMessage,
} from "./relationship-authority.js";

type CompanionProjectionMutation =
  | {
      kind: "relationship_rebuild";
      characterId: string;
    }
  | {
      kind: "relationship_delete";
      characterId: string;
    }
  | { kind: "account_delete" };

export interface CompanionMemoryProjectionPort {
  rebuild(request: CompanionWorkspaceRebuild): Promise<unknown>;
  purge(target: CompanionWorkspacePurgeTarget): Promise<unknown>;
}

interface CanonicalSession {
  id: string;
  messages: RelationshipMessage[];
  linkage: RelationshipLinkage;
}

function eligible(message: RelationshipMessage): boolean {
  return message.status === "sent"
    && message.deletedAt === null
    && ["passed", "unknown"].includes(message.safetyStatus)
    && message.content.trim().length > 0;
}

/** Chat rows are authority; only complete, unambiguous selected exchanges are replayable. */
export function canonicalCompanionMessages(
  sessions: readonly CanonicalSession[],
): CompanionWorkspaceRebuildMessage[] {
  const result: CompanionWorkspaceRebuildMessage[] = [];
  for (const session of sessions) {
    const assistants = session.messages
      .filter((message) =>
        message.role === "assistant"
        && message.memoryAuthority === "enabled"
        && eligible(message)
        && session.linkage.sources.has(message.id))
      .sort(compareMessages);
    for (const assistant of assistants) {
      const source = session.linkage.sources.get(assistant.id);
      if (!source || source.role !== "user" || !eligible(source)) continue;
      result.push(
        {
          id: source.id,
          sessionId: session.id,
          role: "user",
          content: source.content,
          createdAt: source.createdAt.toISOString(),
        },
        {
          id: assistant.id,
          sessionId: session.id,
          role: "assistant",
          content: assistant.content,
          createdAt: assistant.createdAt.toISOString(),
        },
      );
    }
  }
  return result;
}

export async function buildCompanionWorkspaceRebuild(
  tx: Prisma.TransactionClient,
  input: { userId: string; characterId: string },
): Promise<CompanionWorkspaceRebuild> {
  const sessions = await tx.chatSession.findMany({
    where: {
      userId: input.userId,
      characterId: input.characterId,
      status: { not: "deleted" },
      deletedAt: null,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  const canonical: CanonicalSession[] = [];
  // A Prisma interactive transaction owns one pg client. Keep every query
  // sequential; Promise.all here would re-enter that client.
  for (const session of sessions) {
    canonical.push({ id: session.id, ...await loadSessionLinkage(tx, session.id) });
  }
  return companionWorkspaceRebuildSchema.parse({
    scope: "relationship",
    ...input,
    messages: canonicalCompanionMessages(canonical),
  });
}

export function companionMemoryProjectionTimeoutMs(): number {
  return env.COMPANION_RUNTIME_CONFIG.deadlineMs + 30_000;
}

export async function applyCompanionMemoryProjection(
  tx: Prisma.TransactionClient,
  userId: string,
  mutation: CompanionProjectionMutation,
  port?: CompanionMemoryProjectionPort,
): Promise<void> {
  let activePort = port;
  if (!activePort) {
    const config = env.COMPANION_RUNTIME_CONFIG;
    activePort = {
      rebuild: (request: CompanionWorkspaceRebuild) => rebuildCompanionWorkspace({
        baseUrl: config.sidecarUrl,
        token: config.sidecarToken,
        request,
        timeoutMs: config.deadlineMs + 15_000,
      }),
      purge: (target: CompanionWorkspacePurgeTarget) => purgeCompanionWorkspace({
        baseUrl: config.sidecarUrl,
        token: config.sidecarToken,
        target,
        timeoutMs: config.deadlineMs + 15_000,
      }),
    };
  }
  if (mutation.kind === "relationship_rebuild") {
    const request = await buildCompanionWorkspaceRebuild(tx, {
      userId,
      characterId: mutation.characterId,
    });
    // The sidecar performs ephemeral cleanup and canonical replacement under
    // one relationship fence; splitting purge/rebuild here would admit a turn
    // between two control requests.
    await activePort.rebuild(request);
    return;
  }
  await activePort.purge(mutation.kind === "account_delete"
    ? { scope: "user", userId }
    : { scope: "relationship", userId, characterId: mutation.characterId });
}

function compareMessages(left: RelationshipMessage, right: RelationshipMessage): number {
  return left.createdAt.getTime() - right.createdAt.getTime()
    || left.id.localeCompare(right.id);
}
