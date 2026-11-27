import { adminV2Operation, adminV2OperationEndpoint } from "@/lib/admin-v2-operation";
import { characterReleaseCreateMutation } from "@/features/image-workflow-transport";
import { characterCommandMessage } from "./character-command-copy";
import type {
  CharacterCommandJournal,
  CharacterCommandSubmission,
} from "./character-command-journal";

// SPEC: 角色发布与 Serving 命令在客户端只有这一份：请求构造（body / signature / endpoint）、
//       「建候选 + publish」的候选准备、以及命令终局的解释。发布页、详情页、列表卡片、表现页与
//       批量都从这里取，不再各自拼一遍。
// INTENT: 发布页走 journal（持久化 + 同键重放 + 恢复），列表/批量直接调用 adminV2Operation
//         （账本管幂等键）。两条传输各自保留，但它们发出的是同一份请求、读的是同一份结果。

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

// ---------------------------------------------------------------------------
// Release check vocabulary
// ---------------------------------------------------------------------------

const releaseCheckLabels: Record<string, string> = {
  release_generation_authority_kind: "Generation authority",
  project_character_authority: "Character snapshot",
  revision_is_immutable_and_pinned: "Pinned immutable revision",
  soul_snapshot_valid: "Soul snapshot",
  soul_release_policy: "Soul release policy",
  companion_product_contract: "Companion product contract",
  opening_complete: "Opening message",
  visual_identity_exact_version: "Visual identity version",
  reference_set_published_snapshot: "Published reference set",
  generation_route_qualified: "Qualified generation route",
  release_avatar_manifest_available: "Avatar image",
  release_asset_manifest_available: "Display images",
  release_assets_customer_publishable: "Customer-publishable assets",
  release_asset_source_authority: "Image source and availability",
  release_asset_generation_authority: "Asset generation authority",
  snapshot_hash_matches: "Snapshot integrity",
};

export function characterReleaseCheckLabel(checkKey: string) {
  return releaseCheckLabels[checkKey] ?? checkKey.replaceAll("_", " ");
}

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

export type CharacterReleaseCommandKind = "publish" | "rollback" | "withdraw";

interface ReleaseCommandInput {
  readonly characterId: string;
  readonly kind: CharacterReleaseCommandKind;
  readonly release: { readonly id: string; readonly version: number };
  readonly summary: string;
}

export function characterReleaseCommandBody({ characterId, kind, release, summary }: ReleaseCommandInput) {
  return {
    entityVersion: release.version,
    reason: { code: `operator_${kind}`, summary },
    confirmation: `${characterId}:${release.id}:${kind}`,
  };
}

function characterReleaseCommandRequest(input: ReleaseCommandInput) {
  const { characterId, kind, release } = input;
  const body = characterReleaseCommandBody(input);
  return {
    action: `Release ${kind}`,
    operationId: `POST /api/v2/admin/characters/:id/releases/:releaseId/commands/${kind}` as const,
    signature: `${kind}:${release.id}:${JSON.stringify(body)}`,
    path: { id: characterId, releaseId: release.id },
    body,
  };
}

export type CharacterServingAction = "pause" | "resume" | "retire" | "restore";

interface ServingCommandInput {
  readonly characterId: string;
  readonly action: CharacterServingAction;
  readonly entityVersion: number;
  readonly summary: string;
}

/** 运营不填原因；原因摘要按动作与当前状态自动生成（retire 对草稿是归档，对已发布角色是永久退役）。 */
export function characterServingCommandSummary(action: CharacterServingAction, servingState?: string) {
  if (action === "restore") return "Restore draft";
  if (action === "retire") return servingState === "live" || servingState === "paused" ? "Retire Character" : "Archive draft";
  return action === "pause" ? "Pause serving" : "Resume serving";
}

export function characterServingCommandBody({ characterId, action, entityVersion, summary }: ServingCommandInput) {
  return {
    entityVersion,
    reason: { code: `operator_${action}`, summary },
    confirmation: `${characterId}:${action}`,
  };
}

function characterServingCommandRequest(input: ServingCommandInput) {
  const body = characterServingCommandBody(input);
  return {
    action: `Serving ${input.action}`,
    operationId: `POST /api/v2/admin/characters/:id/commands/${input.action}` as const,
    signature: `${input.action}:${input.characterId}:${JSON.stringify(body)}`,
    path: { id: input.characterId },
    body,
  };
}

// ---------------------------------------------------------------------------
// Journal transport (workspace)
// ---------------------------------------------------------------------------

/**
 * SPEC: 发布候选的 durable command 只有这一种提交形状：reason 与 confirmation 由客户端自动生成，
 *       运营不填。调用方必须已经持有 journal.beginSubmission 的写入锁。
 * INVARIANT: signature 含完整 body，恢复语义（同一请求安全重放）由 journal 负责，这里不做任何重试。
 */
export function submitCharacterReleaseCommand(
  journal: CharacterCommandJournal,
  input: ReleaseCommandInput,
) {
  const { action, operationId, signature, path, body } = characterReleaseCommandRequest(input);
  return journal.submit({ action, signature, endpoint: adminV2OperationEndpoint(operationId, path), body });
}

// All workspace serving buttons persist the exact request before sending it.
export async function submitWorkspaceServingCommand(journal: CharacterCommandJournal, input: ServingCommandInput) {
  const { action, operationId, signature, path, body } = characterServingCommandRequest(input);
  if (!journal.beginSubmission(
    characterCommandMessage("Submitting {action}. Character writes stay locked until command acceptance is known.", { action }),
  )) return null;
  try {
    const outcome = await journal.submit({ action, signature, endpoint: adminV2OperationEndpoint(operationId, path), body });
    return outcome.kind === "accepted" ? null : commandSubmissionMessage(outcome, action);
  } catch (cause) {
    journal.abortSubmission();
    throw cause;
  }
}

// ---------------------------------------------------------------------------
// Direct transport (list cards, performance board, bulk)
// ---------------------------------------------------------------------------

/**
 * SPEC: 不经 journal 的 Serving 命令。幂等键由 adminV2Operation 的账本按请求体管理，
 *       重试不会变成第二次写入；entityVersion 仍是 CAS，版本过期由服务端拒绝。
 */
export function requestCharacterServingCommand(input: {
  readonly characterId: string;
  readonly action: CharacterServingAction;
  readonly entityVersion: number;
  readonly servingState?: string;
}) {
  const { path, body } = characterServingCommandRequest({
    ...input,
    summary: characterServingCommandSummary(input.action, input.servingState),
  });
  const options = { path, body };
  switch (input.action) {
    case "pause":
      return adminV2Operation("POST /api/v2/admin/characters/:id/commands/pause", options);
    case "resume":
      return adminV2Operation("POST /api/v2/admin/characters/:id/commands/resume", options);
    case "retire":
      return adminV2Operation("POST /api/v2/admin/characters/:id/commands/retire", options);
    case "restore":
      return adminV2Operation("POST /api/v2/admin/characters/:id/commands/restore", options);
  }
}

export async function submitCharacterServingCommand(input: Parameters<typeof requestCharacterServingCommand>[0] & {
  readonly sleep?: (ms: number) => Promise<void>;
}) {
  const accepted = await requestCharacterServingCommand(input);
  return waitForCharacterCommand(accepted.commandId, input.sleep);
}

/**
 * SPEC: 一键发布 = 复用已有候选，或按当前 Project 版本新建候选；然后提交 publish 命令。
 *       发布页与批量共用这一份候选准备，调用方只决定走哪条传输。
 */
export async function prepareCharacterPublishTarget(input: {
  readonly characterId: string;
  readonly projectVersion: number;
  readonly candidate: { readonly id: string; readonly version: number } | null | undefined;
  readonly summary: string;
}) {
  if (input.candidate) return { id: input.candidate.id, version: input.candidate.version };
  const mutation = characterReleaseCreateMutation(
    input.characterId,
    input.projectVersion,
    input.summary,
    `${input.characterId}:publish`,
  );
  const created = await adminV2Operation(mutation.operationId, mutation.options);
  return { id: created.id, version: created.version };
}

export async function publishCharacterDirect(input: {
  readonly characterId: string;
  readonly projectVersion: number;
  readonly candidate: { readonly id: string; readonly version: number } | null | undefined;
  readonly sleep?: (ms: number) => Promise<void>;
}) {
  const summary = "Publish current Character";
  const release = await prepareCharacterPublishTarget({ ...input, summary });
  const { path, body } = characterReleaseCommandRequest({
    characterId: input.characterId,
    kind: "publish",
    release,
    summary,
  });
  const accepted = await adminV2Operation(
    "POST /api/v2/admin/characters/:id/releases/:releaseId/commands/publish",
    { path, body },
  );
  return waitForCharacterCommand(accepted.commandId, input.sleep);
}

// ---------------------------------------------------------------------------
// Result interpretation
// ---------------------------------------------------------------------------

export interface CharacterCommandFailure {
  readonly status: string;
  readonly code: string | null;
  /** 发布校验失败时的检查项 key；与 releaseBlockerGuidance 同一词表。 */
  readonly blockers: readonly string[];
  /** 服务端已在同一事务里撤回候选，草稿可立即编辑。 */
  readonly candidateWithdrawn: boolean;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function characterCommandFailure(status: string, error: unknown): CharacterCommandFailure {
  const evidence = recordOf(error);
  const blockers = Array.isArray(evidence.blockers)
    ? [...new Set(evidence.blockers.filter((item): item is string => typeof item === "string" && item.length > 0))]
    : [];
  return {
    status,
    code: typeof evidence.code === "string" ? evidence.code : null,
    blockers,
    candidateWithdrawn: evidence.candidateWithdrawn === true,
  };
}

/** 运营可读的一句终局。blockers 由调用方按 characterReleaseCheckLabel 另行列出。 */
export function characterCommandFailureMessage(failure: CharacterCommandFailure) {
  if (failure.blockers.length > 0) {
    return failure.candidateWithdrawn
      ? "Release checks failed. The candidate was withdrawn and the draft can be edited again."
      : "Release checks failed.";
  }
  // 快照无法投影等没有检查项的失败：候选同样已撤回，必须说出来，不能只剩「命令失败」。
  if (failure.candidateWithdrawn) {
    return "The release could not go live. The candidate was withdrawn and the draft can be edited again.";
  }
  return failure.status === "cancelled" ? "Command cancelled." : "Command failed.";
}

export class CharacterCommandFailedError extends Error {
  constructor(readonly failure: CharacterCommandFailure) {
    super(characterCommandFailureMessage(failure));
    this.name = "CharacterCommandFailedError";
  }
}

export type CharacterCommandStatusReading =
  | { readonly state: "running" }
  | { readonly state: "succeeded" }
  | { readonly state: "failed"; readonly failure: CharacterCommandFailure };

export function readCharacterCommandStatus(status: { readonly status: string; readonly error?: unknown }): CharacterCommandStatusReading {
  if (status.status === "succeeded") return { state: "succeeded" };
  if (status.status === "failed" || status.status === "cancelled") {
    return { state: "failed", failure: characterCommandFailure(status.status, status.error) };
  }
  return { state: "running" };
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * SPEC: 短轮询一条已受理的命令。终局失败抛 CharacterCommandFailedError（带 blockers）；
 *       读不到或超时返回 accepted，交给列表刷新继续跟踪。
 */
export async function waitForCharacterCommand(commandId: string, sleep: (ms: number) => Promise<void> = defaultSleep) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await sleep(700);
    const command = await adminV2Operation("GET /api/v2/admin/commands/:commandId", {
      path: { commandId },
    }).catch(() => null);
    if (!command) return "accepted" as const;
    const reading = readCharacterCommandStatus(command);
    if (reading.state === "succeeded") return "succeeded" as const;
    if (reading.state === "failed") throw new CharacterCommandFailedError(reading.failure);
  }
  return "accepted" as const;
}
