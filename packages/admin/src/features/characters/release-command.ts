import { adminV2OperationEndpoint } from "@/lib/admin-v2-operation";
import { characterCommandMessage } from "./character-command-copy";
import type {
  CharacterCommandJournal,
  CharacterCommandSubmission,
} from "./character-command-journal";

export function commandSubmissionMessage(
  outcome: Exclude<CharacterCommandSubmission, { readonly kind: "accepted" }>,
  action: string,
) {
  if (outcome.kind === "attached") {
    return characterCommandMessage("{action} is already active. This workspace attached to that command instead of accepting another one.", { action: outcome.command.action });
  }
  return outcome.cause instanceof Error
    ? outcome.cause.message
    : characterCommandMessage("{action} acceptance is unknown. The same command will be replayed safely.", { action });
}

/**
 * SPEC: 发布候选的 durable command 只有这一种提交形状：reason 与 confirmation 由客户端自动生成，
 *       运营不填。调用方必须已经持有 journal.beginSubmission 的写入锁。
 * INVARIANT: signature 含完整 body，恢复语义（同一请求安全重放）由 journal 负责，这里不做任何重试。
 */
export function submitCharacterReleaseCommand(
  journal: CharacterCommandJournal,
  input: {
    readonly characterId: string;
    readonly kind: "publish" | "rollback" | "withdraw";
    readonly release: { readonly id: string; readonly version: number };
    readonly summary: string;
  },
) {
  const { characterId, kind, release, summary } = input;
  const body = {
    entityVersion: release.version,
    reason: { code: `operator_${kind}`, summary },
    confirmation: `${characterId}:${release.id}:${kind}`,
  };
  return journal.submit({
    action: `Release ${kind}`,
    signature: `${kind}:${release.id}:${JSON.stringify(body)}`,
    endpoint: adminV2OperationEndpoint(
      `POST /api/v2/admin/characters/:id/releases/:releaseId/commands/${kind}`,
      { id: characterId, releaseId: release.id },
    ),
    body,
  });
}
