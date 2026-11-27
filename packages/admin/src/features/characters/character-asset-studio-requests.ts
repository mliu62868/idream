// SPEC: Character Asset Studio 的请求形状 —— Run 列表读取、Run 创建请求体与写入失败文案，均为纯函数。
// INTENT: 从 CharacterAssetStudio.tsx 原样移出，纯机械搬运，没有任何行为改动。
//         闸门的 begin / isCurrent / invalidate 时序仍由组件里的 loadRuns 串起来，这里只负责
//         「开始一次读取」与「把读回的页并进状态」两段同步逻辑。
import {
  creativeRunCreateRequestSchema,
  type CharacterImageSourceAsset,
  type CreativeRun,
  type CreativeRunFillSkip,
} from "@idream/shared/admin";
import type { AdminI18nContextValue } from "@/components/admin/i18n";
import { AdminV2RequestError } from "@/lib/admin-v2-api";
import { adminV2Operation, type AdminV2OperationResponse } from "@/lib/admin-v2-operation";
import type { DurableMutationIntent } from "@/lib/durable-mutation-intent";
import { isProjectionRequestCancellation } from "@/lib/committed-projection";
import type { LatestRequestGate } from "@/lib/latest-request";
import {
  characterAssetRunRequestKey,
  committedRunProjectionUnavailable,
  isCharacterAssetPurpose,
  purposeConfig,
  type CharacterAssetPurpose,
} from "./character-asset-studio-authority";

type CreativeRunCreateRequest = ReturnType<typeof creativeRunCreateRequestSchema.parse>;
type CreativeRunListPage = AdminV2OperationResponse<"GET /api/v2/admin/creative/runs">;

export function savedAssetRunRequest(intent: DurableMutationIntent | null, characterId: string) {
  const saved = creativeRunCreateRequestSchema.safeParse(intent?.requestSnapshot);
  return saved.success && saved.data.targetType === "character" &&
    saved.data.targetId === characterId && isCharacterAssetPurpose(saved.data.purpose)
    ? { ...saved.data, purpose: saved.data.purpose } : null;
}

export type CharacterAssetRunPages = {
  purpose: CharacterAssetPurpose | null;
  history: CreativeRun[];
  active: CreativeRun[];
  cursor: string | null;
};

// Starts one list read synchronously: gate tokens are taken and requests are
// sent before the caller awaits `pages`, exactly as the inline read did.
export function beginCharacterAssetRunListRead(input: {
  readonly gates: {
    readonly runList: LatestRequestGate;
    readonly activeRuns: LatestRequestGate;
    readonly historyPage: LatestRequestGate;
  };
  readonly characterId: string;
  readonly purpose: CharacterAssetPurpose;
  readonly activeOnly: boolean;
  readonly cursor: string | undefined;
  readonly signal: AbortSignal | undefined;
}) {
  const { activeOnly, cursor, gates } = input;
  const fullRead = !activeOnly && !cursor;
  const request = cursor
    ? gates.historyPage.begin()
    : activeOnly
      ? gates.activeRuns.begin()
      : gates.runList.begin();
  const activeRequest = activeOnly
    ? request
    : fullRead
      ? gates.activeRuns.begin()
      : null;
  if (fullRead) gates.historyPage.invalidate();
  const baseQuery = {
    limit: "20",
    targetType: "character",
    targetId: input.characterId,
    purpose: input.purpose,
    sort: "updated_desc",
  };
  const readPage = (extra: Record<string, string>) => adminV2Operation(
    "GET /api/v2/admin/creative/runs",
    { query: new URLSearchParams({ ...baseQuery, ...extra }),
      ...(input.signal ? { signal: input.signal } : {}) },
  );
  // History membership is never evidence that no request is running. Keep
  // the two execution states independently discoverable even behind pages
  // of completed work; the server owns both purpose and outcome filtering.
  const pages = Promise.all([
    activeOnly ? Promise.resolve(null) : readPage(cursor ? { cursor } : {}),
    cursor ? Promise.resolve(null) : readPage({ executionOutcome: "pending" }),
    cursor ? Promise.resolve(null) : readPage({ executionOutcome: "running" }),
  ]);
  return { fullRead, request, activeRequest, pages };
}

export function scopeCharacterAssetRunPages(input: {
  readonly history: CreativeRunListPage | null;
  readonly pending: CreativeRunListPage | null;
  readonly running: CreativeRunListPage | null;
  readonly purpose: CharacterAssetPurpose;
}) {
  const { history, pending, running, purpose: activePurpose } = input;
  const active = pending && running
    ? [...pending.items, ...running.items].filter((run) => run.purpose === activePurpose)
    : [];
  const historyItems = history?.items.filter((run) => run.purpose === activePurpose) ?? [];
  const scoped = [...new Map([...historyItems, ...active].map((run) => [run.id, run])).values()];
  return { active, historyItems, scoped };
}

export function mergeCharacterAssetRunPages(
  current: CharacterAssetRunPages,
  input: {
    readonly purpose: CharacterAssetPurpose;
    readonly cursor: string | undefined;
    readonly history: CreativeRunListPage | null;
    readonly historyItems: CreativeRun[];
    readonly active: CreativeRun[];
    readonly activeIsNewest: boolean;
  },
): CharacterAssetRunPages {
  const { active, activeIsNewest, cursor, history, historyItems, purpose: activePurpose } = input;
  const samePurpose = current.purpose === activePurpose;
  const previousHistory = samePurpose ? current.history : [];
  const nextActive = activeIsNewest ? active : samePurpose ? current.active : [];
  if (!history) return {
    purpose: activePurpose, active: nextActive, history: previousHistory,
    cursor: samePurpose ? current.cursor : null,
  };
  return {
    purpose: activePurpose,
    active: nextActive,
    history: cursor
      ? [...new Map([...previousHistory, ...historyItems].map((run) => [run.id, run])).values()]
      : historyItems,
    cursor: history.pageInfo.hasNextPage ? history.pageInfo.endCursor : null,
  };
}

export function characterAssetRunRequestDraft(input: {
  readonly purpose: CharacterAssetPurpose;
  readonly referenceAssetIds: string[];
  readonly subjectName: string;
  readonly characterId: string;
  readonly profileId: string;
  readonly bootstrapMode: boolean;
  readonly orientation: string | null | undefined;
  readonly brief: string;
  readonly negativePrompt: string;
}) {
  const { bootstrapMode, orientation, purpose, referenceAssetIds } = input;
  return {
    // This title is persisted creative input, not translated interface copy.
    title: `${input.subjectName} · ${purposeConfig[purpose].label}`,
    purpose,
    targetType: "character" as const,
    targetId: input.characterId,
    profileId: input.profileId,
    presetIds: [],
    referenceAssetIds,
    bootstrapIdentity: bootstrapMode,
    ...(orientation ? { orientation } : {}),
    count: 1,
    brief: input.brief.trim(),
    ...(input.negativePrompt.trim() ? { negativePrompt: input.negativePrompt.trim() } : {}),
    consistencyMode: "strict" as const,
    priority: "normal" as const,
    reason: bootstrapMode
      ? "Create the first identity portrait"
      : referenceAssetIds.length
        ? "Create identity-preserving variations from the selected character asset"
        : "Create a customer-facing character asset pack candidate",
  };
}

export function parseCharacterAssetRunRequest(snapshot: unknown, characterId: string) {
  const parsed = creativeRunCreateRequestSchema.safeParse(snapshot);
  return parsed.success && parsed.data.targetType === "character" &&
    parsed.data.targetId === characterId && isCharacterAssetPurpose(parsed.data.purpose)
    ? parsed.data : null;
}

export function characterAssetRunRequestSignature(
  body: CreativeRunCreateRequest,
  characterId: string,
  subjectName: string,
) {
  return characterAssetRunRequestKey({
    characterId,
    title: body.title ?? `${subjectName} · ${purposeConfig[body.purpose as CharacterAssetPurpose].label}`,
    purpose: body.purpose as CharacterAssetPurpose,
    profileId: body.profileId,
    referenceAssetIds: body.referenceAssetIds,
    bootstrapIdentity: body.bootstrapIdentity,
    orientation: body.orientation ?? "",
    count: body.count,
    runCount: body.runCount,
    brief: body.brief,
    negativePrompt: body.negativePrompt,
  });
}

export function characterAssetRunBlockedMessage(status: DurableMutationIntent["status"]) {
  return status === "committed_projection_pending"
    ? "Another tab already has a committed Character Run receipt. Verify it before creating again."
    : status === "reconciliation_required"
      ? "Another tab has an aged Character Run receipt. Reconcile it with the server before creating again."
      : "Another tab already started a different Character image request. Its exact context is locked for safe resume.";
}

export function characterImageProductionPreparationError(cause: unknown) {
  // INTENT: 只有服务端明确拒绝（4xx）才能断言线上图片没变；超时或 5xx 时提交可能已经落地，
  //         这时让运营先刷新核对，而不是保证「什么都没发生」再诱导重试。
  if (cause instanceof AdminV2RequestError && cause.outcome === "answered" && cause.status === 409) {
    return "Image production was not enabled because this Character changed elsewhere. Refresh the page and try again.";
  }
  if (
    cause instanceof AdminV2RequestError &&
    cause.outcome === "answered" &&
    [400, 401, 403, 404, 422].includes(cause.status)
  ) {
    return cause.message;
  }
  return "Image production preparation could not be confirmed. Refresh the page to check whether it was applied before trying again.";
}

// A committed "candidate_available" skip names a library asset; it is offered
// only after this exact asset is confirmed selectable for that placement.
export async function confirmCharacterLibraryCandidate(
  { purpose, skip }: { readonly purpose: CharacterAssetPurpose; readonly skip: CreativeRunFillSkip },
  libraryAssets: readonly CharacterImageSourceAsset[],
  characterId: string,
) {
  if (skip.reason !== "candidate_available") return null;
  const asset = libraryAssets.find((item) => item.id === skip.assetId) ?? (
    await adminV2Operation("GET /api/v2/admin/characters/:id/image-sources", {
      path: { id: characterId },
      query: new URLSearchParams({ purpose: "character_library", search: skip.assetId }),
    })
  ).items.find((item) => item.id === skip.assetId);
  return asset?.qualification?.selectablePurposes.includes(purpose) ? { purpose, asset } : null;
}

export function characterAssetRunSubmittedMessage(
  body: CreativeRunCreateRequest,
  t: AdminI18nContextValue["t"],
) {
  return body.runCount
    ? t("Started {count} image runs. Each appears in the run history.", { count: body.runCount })
    : body.bootstrapIdentity
    ? "First-portrait generation was committed. Results will appear here automatically."
    : body.referenceAssetIds.length
      ? "Variation run was committed from this candidate."
      : "Generation was committed. Results will appear here automatically.";
}

// SPEC: Run 创建失败时按「是否已提交 / 保存的 intent 状态」分流：已提交只进旁注（warning），
//       其余进主错误；被取代的投影读取两者都不报。
export function characterAssetRunCreationFailure(input: {
  readonly cause: unknown;
  readonly committedRun: boolean;
  readonly intentStatus: DurableMutationIntent["status"] | undefined;
  readonly t: AdminI18nContextValue["t"];
}): { readonly kind: "warning" | "error"; readonly message: string } | null {
  const { cause, committedRun, intentStatus, t } = input;
  if (committedRun || intentStatus === "committed_projection_pending") {
    if (!isProjectionRequestCancellation(cause)) {
      return { kind: "warning", message: committedRunProjectionUnavailable(cause instanceof Error ? cause.message : null, t) };
    }
    return null;
  }
  if (intentStatus === "outcome_unknown") {
    return { kind: "error", message: "Generation outcome is unknown. Choose Resume generation to replay the same intent without creating a duplicate Run." };
  }
  if (intentStatus === "reconciliation_required" && cause instanceof AdminV2RequestError) {
    return { kind: "error", message: t("Generation outcome still needs server confirmation: {detail}. Choose Reconcile saved request; it cannot create a duplicate Run.", { detail: t(cause.message) }) };
  }
  return {
    kind: "error",
    message: cause instanceof AdminV2RequestError && cause.status === 503 &&
      cause.code === "unavailable" && cause.message.includes("No Run was created")
      ? "Image generation is offline. Restore backend health, then generate again. No Run was created."
      : cause instanceof Error ? cause.message : "The saved generation request could not be reconciled.",
  };
}
