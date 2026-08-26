import {
  type CompanionWorkspaceRebuild,
  type CompanionWorkspaceRebuildFence,
  type CompanionWorkspaceRebuildMessage,
  type CompanionWorkspaceRebuildPromotion,
} from "@idream/shared/chat/companion-runtime";
import type { Prisma } from "../generated/client/client.js";
import { env } from "./env.js";
import {
  discardCompanionWorkspaceRebuild,
  prepareCompanionWorkspaceRebuild,
  promoteCompanionWorkspaceRebuild,
  purgeCompanionWorkspace,
  type CompanionWorkspacePurgeTarget,
} from "./companion-runtime.js";
import {
  loadRelationshipLinkages,
  loadRelationshipResetAt,
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
      /** Ledger mutation id; names the quarantined sidecar workspace and relationship files alike. */
      quarantine: string;
    }
  | { kind: "account_delete" };

export interface CompanionMemoryProjectionPort {
  rebuild?(request: CompanionWorkspaceRebuild): Promise<unknown>;
  purge(target: CompanionWorkspacePurgeTarget): Promise<unknown>;
  prepare?(request: CompanionWorkspaceRebuild & {
    fence: CompanionWorkspaceRebuildFence;
  }): Promise<{ rebuildId: string; sessions: number; messages: number }>;
  promote?(request: CompanionWorkspaceRebuildPromotion): Promise<unknown>;
  discard?(request: CompanionWorkspaceRebuildPromotion): Promise<void>;
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

/**
 * Chat rows are authority; only complete, unambiguous selected exchanges are replayable.
 * `resetAt` is the relationship-reset watermark: a user who reset this bond asked the
 * companion to stop knowing everything said before that moment, so a replay must not
 * hand those exchanges back. Both halves of an exchange must clear the watermark —
 * a turn straddling the reset is pre-reset content.
 */
export function canonicalCompanionMessages(
  sessions: readonly CanonicalSession[],
  resetAt: Date | null = null,
): CompanionWorkspaceRebuildMessage[] {
  const epochStart = resetAt?.getTime() ?? null;
  const inEpoch = (message: RelationshipMessage): boolean =>
    epochStart === null || message.createdAt.getTime() > epochStart;
  const result: CompanionWorkspaceRebuildMessage[] = [];
  for (const session of sessions) {
    const assistants = session.messages
      .filter((message) =>
        message.role === "assistant"
        && message.memoryAuthority === "enabled"
        && eligible(message)
        && inEpoch(message)
        && session.linkage.sources.has(message.id))
      .sort(compareMessages);
    for (const assistant of assistants) {
      const source = session.linkage.sources.get(assistant.id);
      if (!source || source.role !== "user" || !eligible(source)) continue;
      if (!inEpoch(source)) continue;
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
  const sessions = await loadRelationshipLinkages(tx, input);
  const resetAt = await loadRelationshipResetAt(tx, input);
  const messages: CompanionWorkspaceRebuildMessage[] = [];
  // Content strings are reused, not cloned. The result array is the only
  // additional aggregate transcript retained at the Chat transport seam.
  for (const session of sessions) {
    const projected = canonicalCompanionMessages([session], resetAt);
    for (const message of projected) messages.push(message);
  }
  return {
    scope: "relationship",
    ...input,
    messages,
  };
}

export function companionMemoryProjectionTimeoutMs(): number {
  // Only claim/snapshot/authority/settle DB work runs inside this transaction;
  // sidecar ingest and maintenance are deliberately outside it.
  return 120_000;
}

export function companionMemoryProjectionPort(): CompanionMemoryProjectionPort {
  const config = env.COMPANION_RUNTIME_CONFIG;
  return {
    purge: (target) => purgeCompanionWorkspace({
      baseUrl: config.sidecarUrl,
      token: config.sidecarToken,
      target,
      timeoutMs: 60_000,
    }),
    prepare: (request) => prepareCompanionWorkspaceRebuild({
      baseUrl: config.sidecarUrl,
      token: config.sidecarToken,
      request,
    }),
    promote: (request) => promoteCompanionWorkspaceRebuild({
      baseUrl: config.sidecarUrl,
      token: config.sidecarToken,
      request,
    }),
    discard: (request) => discardCompanionWorkspaceRebuild({
      baseUrl: config.sidecarUrl,
      token: config.sidecarToken,
      request,
    }),
  };
}

export async function applyCompanionMemoryProjection(
  tx: Prisma.TransactionClient,
  userId: string,
  mutation: CompanionProjectionMutation,
  port?: CompanionMemoryProjectionPort,
): Promise<void> {
  const activePort = port ?? companionMemoryProjectionPort();
  if (mutation.kind === "relationship_rebuild") {
    const request = await buildCompanionWorkspaceRebuild(tx, {
      userId,
      characterId: mutation.characterId,
    });
    // The sidecar performs ephemeral cleanup and canonical replacement under
    // one relationship fence; splitting purge/rebuild here would admit a turn
    // between two control requests.
    if (!activePort.rebuild) {
      throw new Error("relationship rebuild requires the durable fenced projector");
    }
    await activePort.rebuild(request);
    return;
  }
  // A reset retires the relationship workspace for engineering analysis; an
  // account purge destroys the whole user directory, quarantine included.
  await activePort.purge(mutation.kind === "account_delete"
    ? { scope: "user", userId }
    : {
        scope: "relationship",
        userId,
        characterId: mutation.characterId,
        quarantine: mutation.quarantine,
      });
}

function compareMessages(left: RelationshipMessage, right: RelationshipMessage): number {
  return left.createdAt.getTime() - right.createdAt.getTime()
    || left.id.localeCompare(right.id);
}
