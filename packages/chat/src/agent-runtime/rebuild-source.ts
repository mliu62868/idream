import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import {
  companionWorkspaceRebuildMetrics,
  type CompanionWorkspaceRebuild,
  type CompanionWorkspaceBuildMode,
  type CompanionWorkspaceRebuildFence,
  type CompanionWorkspaceRebuildPromotion,
} from "@idream/shared/chat/companion-runtime";

export interface CompanionWorkspaceRebuildSpool {
  kind: "spool";
  scope: "relationship";
  userId: string;
  characterId: string;
  mode: CompanionWorkspaceBuildMode;
  messageCount: number;
  sessionCount: number;
  estimatedBytes: number;
  manifestPath: string;
  fence?: CompanionWorkspaceRebuildFence;
}

export type CompanionWorkspaceRebuildSource =
  | CompanionWorkspaceRebuild
  | CompanionWorkspaceRebuildSpool;

export type { CompanionWorkspaceRebuildPromotion };

export function rebuildSourceMetrics(source: CompanionWorkspaceRebuildSource): {
  messageCount: number;
  sessionCount: number;
  estimatedBytes: number;
} {
  if ("kind" in source) {
    return {
      messageCount: source.messageCount,
      sessionCount: source.sessionCount,
      estimatedBytes: source.estimatedBytes,
    };
  }
  return companionWorkspaceRebuildMetrics(source);
}

export interface CompanionWorkspaceRebuildSpoolSession {
  sessionId: string;
  transcriptPath: string;
  messageCount: number;
  estimatedBytes: number;
}

export async function* rebuildSpoolSessions(
  source: CompanionWorkspaceRebuildSpool,
): AsyncGenerator<CompanionWorkspaceRebuildSpoolSession> {
  const lines = createInterface({
    input: createReadStream(source.manifestPath, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of lines) {
    if (!line) throw new Error("relationship rebuild spool manifest contains an empty row");
    const row = JSON.parse(line) as Partial<CompanionWorkspaceRebuildSpoolSession>;
    if (
      typeof row.sessionId !== "string"
      || typeof row.transcriptPath !== "string"
      || !Number.isSafeInteger(row.messageCount)
      || Number(row.messageCount) <= 0
      || !Number.isSafeInteger(row.estimatedBytes)
      || Number(row.estimatedBytes) <= 0
    ) {
      throw new Error("relationship rebuild spool manifest row is invalid");
    }
    yield row as CompanionWorkspaceRebuildSpoolSession;
  }
}
