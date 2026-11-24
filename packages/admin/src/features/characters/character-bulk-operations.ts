import {
  type CharacterPortfolioItem,
  type CharacterWorkspaceDetail,
} from "@idream/shared/admin";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import { clearDurableMutationIntent } from "@/lib/durable-mutation-intent";
import { purposeConfig, type CharacterAssetPurpose } from "./character-asset-studio-authority";
import { characterImageFillSkipMessage, createOrRecoverMissingCharacterImage, defaultCharacterImageBrief } from "./creative-run-creation";

// SPEC: 列表批量操作：逐项调用现有单角色命令，每项独立成败。不新增服务端 bulk 命令，
//       不做键入确认或预览闸门；幂等、CAS 和不可变 Release 都还由单角色命令保证。
export const BULK_CONCURRENCY = 4;
// 生成有真实费用，这个上限只卡生成，其他动作可以多选。
export const BULK_GENERATION_CHARACTER_LIMIT = 20;
const MAX_CHARACTER_TAGS = 24;

export type BulkAction =
  | { readonly kind: "pause" | "resume" | "archive" | "generate_missing" }
  | { readonly kind: "add_tag" | "remove_tag"; readonly tagId: string; readonly tagLabel: string };

export const BULK_ACTION_LABELS: Record<BulkAction["kind"], string> = {
  pause: "Pause",
  resume: "Resume",
  archive: "Archive",
  add_tag: "Add tag",
  remove_tag: "Remove tag",
  generate_missing: "Generate missing images",
};

const GENERATION_BLOCKER_COPY: Readonly<Record<
  NonNullable<CharacterPortfolioItem["journey"]["assetPack"]["generateMissingBlocker"]>,
  string
>> = {
  visual_identity_missing: "No visual identity yet.",
  reference_set_not_active: "The Reference Set is not active yet.",
  generation_route_unqualified: "No qualified image route. Platform operations can fix this.",
  image_run_in_progress: "An image is already in progress.",
  image_run_outcome_unknown: "Check the image with an unknown outcome first.",
  active_command: "Another command is in progress.",
};

export function bulkMissingPurposes(item: CharacterPortfolioItem) {
  return item.journey.assetPack.generateMissingPurposes;
}

export function bulkActionBlocker(
  kind: BulkAction["kind"],
  item: CharacterPortfolioItem,
): string | null {
  const state = item.serving.state;
  const commandBusy = item.journey.hasActiveCommand;
  if (kind === "pause") {
    if (state !== "live") return "Only live characters can be paused.";
    return commandBusy ? "Another command is in progress." : null;
  }
  if (kind === "resume") {
    if (state !== "paused") return "Only paused characters can be resumed.";
    return commandBusy ? "Another command is in progress." : null;
  }
  if (kind === "archive") {
    // INTENT: 退役已发布角色不可撤销，留在发布页；这里只归档可恢复的未发布草稿。
    if (state !== "inactive") return "Only unpublished drafts can be archived here.";
    return commandBusy ? "Another command is in progress." : null;
  }
  if (kind === "add_tag" || kind === "remove_tag") return null;
  if (state === "retired") return "Archived or retired.";
  const blocker = item.journey.assetPack.generateMissingBlocker;
  if (blocker) return GENERATION_BLOCKER_COPY[blocker];
  return bulkMissingPurposes(item).length === 0 ? "No missing images." : null;
}

export type BulkTaskState = "queued" | "running" | "succeeded" | "accepted" | "failed";
export interface BulkTask {
  readonly id: string;
  readonly characterId: string;
  readonly name: string;
  readonly purpose: CharacterAssetPurpose | null;
  readonly state: BulkTaskState;
  readonly message: string | null;
  readonly attempts: number;
}

export function planBulkTasks(action: BulkAction, items: readonly CharacterPortfolioItem[]) {
  const eligible = items.filter((item) => bulkActionBlocker(action.kind, item) === null);
  const skipped = items.flatMap((item) => {
    const reason = bulkActionBlocker(action.kind, item);
    return reason ? [{ characterId: item.characterId, name: item.name, reason }] : [];
  });
  const base = { state: "queued" as const, message: null, attempts: 0 };
  const tasks = eligible.flatMap((item): BulkTask[] =>
    action.kind === "generate_missing"
      ? bulkMissingPurposes(item).map((purpose) => ({
          ...base,
          id: `${item.characterId}:${purpose}`,
          characterId: item.characterId,
          name: item.name,
          purpose,
        }))
      : [{ ...base, id: item.characterId, characterId: item.characterId, name: item.name, purpose: null }],
  );
  return {
    tasks,
    skipped,
    characterCount: eligible.length,
    overGenerationLimit:
      action.kind === "generate_missing" && eligible.length > BULK_GENERATION_CHARACTER_LIMIT,
  };
}

// SPEC: 并发上限内逐项执行；一项失败不影响其他项，结果逐条回报。
export async function runBulkTasks<T extends { readonly id: string }>(
  tasks: readonly T[],
  worker: (task: T) => Promise<void>,
  concurrency = BULK_CONCURRENCY,
) {
  const queue = [...tasks];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let task = queue.shift(); task; task = queue.shift()) await worker(task);
    }),
  );
}

// SPEC: count=1；路线与画幅规则同 Asset Studio。bootstrap 的第一张身份肖像不走批量，要人看。
export function bulkGenerationRequest(
  detail: CharacterWorkspaceDetail,
  purpose: CharacterAssetPurpose,
  name: string,
) {
  const visual = detail.visual;
  if (visual.identityBootstrap.allowed) throw new Error("No visual identity yet.");
  if (!visual.readiness.ready) throw new Error("This Character's image production is not ready.");
  const route = visual.routeQualifications.find(
    (candidate) => candidate.result === "qualified" && !candidate.stale,
  );
  if (!route) throw new Error("No qualified image route. Platform operations can fix this.");
  const profile = visual.identityCalibration?.profiles.find(
    (candidate) =>
      candidate.profileKey === route.generationProfileKey &&
      candidate.profileVersion === route.generationProfileVersion &&
      candidate.workflowKey === route.workflowKey &&
      candidate.workflowVersion === route.workflowVersion,
  );
  const preferred = purposeConfig[purpose].orientation;
  const allowed = profile?.allowedOrientations;
  const orientation = allowed?.includes(preferred) ? preferred : allowed?.[0];
  return {
    title: `${name} · ${purposeConfig[purpose].label}`,
    purpose,
    targetType: "character" as const,
    targetId: detail.character.id,
    profileId: route.generationProfileKey,
    presetIds: [],
    referenceAssetIds: [],
    bootstrapIdentity: false,
    ...(orientation ? { orientation } : {}),
    count: 1,
    brief: defaultCharacterImageBrief(purpose, name, detail.preview.draft.appearance.referenceDirection),
    consistencyMode: "strict" as const,
    priority: "normal" as const,
    reason: "Fill a missing image from the Character list",
  };
}

export type BulkServingAction = "pause" | "resume" | "retire";

const SERVING_SUMMARY: Record<BulkServingAction, string> = {
  pause: "Pause serving",
  resume: "Resume serving",
  retire: "Archive draft",
};

async function waitForCommand(commandId: string, sleep: (ms: number) => Promise<void>) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await sleep(700);
    const command = await adminV2Operation("GET /api/v2/admin/commands/:commandId", {
      path: { commandId },
    }).catch(() => null);
    if (!command) return "accepted" as const;
    if (command.status === "succeeded") return "succeeded" as const;
    if (command.status === "failed" || command.status === "cancelled") {
      throw new Error(`Command ${command.status}.`);
    }
  }
  return "accepted" as const;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// SPEC: 与发布页同一条命令；reason 自动填，不问运营。幂等键由 adminV2Operation 的账本管，
//       重试不会变成第二次写入；entityVersion 仍是 CAS，版本过期由服务端拒绝。
export async function submitServingCommand(input: {
  readonly characterId: string;
  readonly action: BulkServingAction;
  readonly entityVersion: number;
  readonly sleep?: (ms: number) => Promise<void>;
}) {
  const { characterId, action } = input;
  const options = {
    path: { id: characterId },
    body: {
      entityVersion: input.entityVersion,
      reason: { code: `operator_${action}`, summary: SERVING_SUMMARY[action] },
      confirmation: `${characterId}:${action}`,
    },
  };
  const accepted = action === "pause"
    ? await adminV2Operation("POST /api/v2/admin/characters/:id/commands/pause", options)
    : action === "resume"
      ? await adminV2Operation("POST /api/v2/admin/characters/:id/commands/resume", options)
      : await adminV2Operation("POST /api/v2/admin/characters/:id/commands/retire", options);
  return waitForCommand(accepted.commandId, input.sleep ?? defaultSleep);
}

async function changeTag(characterId: string, tagId: string, add: boolean) {
  const { character } = await adminV2Operation("GET /api/v2/admin/content/characters/:id", {
    path: { id: characterId },
  });
  const current = character.tags.map((tag: { readonly id: string }) => tag.id);
  const next = add
    ? [...new Set([...current, tagId])]
    : current.filter((id: string) => id !== tagId);
  if (next.length === current.length && next.every((id: string) => current.includes(id))) return;
  if (next.length > MAX_CHARACTER_TAGS) {
    throw new Error("This Character already has the maximum number of tags.");
  }
  await adminV2Operation("PUT /api/v2/admin/content/characters/:id/tags", {
    path: { id: characterId },
    body: { tagIds: next, confirmation: `${characterId}:tags` },
  });
}

// 同一 Creative Run 接纳 module 处理工作台与批量。浏览器仍保存每个槽位的原始请求直至收到精确回执。
async function createMissingImage(input: {
  readonly actorId: string;
  readonly detail: CharacterWorkspaceDetail;
  readonly purpose: CharacterAssetPurpose;
  readonly name: string;
}) {
  const characterId = input.detail.character.id;
  const scope = `character-bulk-run:${input.actorId}:${characterId}:${input.purpose}`;
  const { result, intent } = await createOrRecoverMissingCharacterImage({
    scope,
    characterId,
    purpose: input.purpose,
    draft: () => bulkGenerationRequest(input.detail, input.purpose, input.name),
  });
  if (result.state === "committed") {
    if (intent) clearDurableMutationIntent(intent);
    return "accepted" as const;
  }
  if (result.state === "skipped") return { state: "succeeded" as const, message: characterImageFillSkipMessage[result.skip.reason] };
  if (result.state === "superseded") return "accepted" as const;
  if (result.state === "cancelled") throw new Error("The earlier request created nothing. Retry to create it.");
  throw new Error("The earlier request is still unconfirmed. Retry to check it; this cannot create a duplicate.");
}

export function createBulkExecutor(input: {
  readonly action: BulkAction;
  readonly actorId: string;
  readonly itemByCharacter: ReadonlyMap<string, CharacterPortfolioItem>;
  readonly sleep?: (ms: number) => Promise<void>;
}) {
  const details = new Map<string, Promise<CharacterWorkspaceDetail>>();
  const detail = (characterId: string, fresh = false) => {
    let pending = fresh ? undefined : details.get(characterId);
    if (!pending) {
      pending = adminV2Operation("GET /api/v2/admin/characters/:id", {
        path: { id: characterId },
      }) as Promise<CharacterWorkspaceDetail>;
      details.set(characterId, pending);
    }
    return pending;
  };
  return async (task: BulkTask): Promise<"succeeded" | "accepted" | { state: "succeeded"; message: string }> => {
    const item = input.itemByCharacter.get(task.characterId);
    if (!item) throw new Error("This Character is no longer available.");
    const { action } = input;
    if (action.kind === "add_tag" || action.kind === "remove_tag") {
      await changeTag(task.characterId, action.tagId, action.kind === "add_tag");
      return "succeeded";
    }
    if (action.kind === "generate_missing") {
      if (!task.purpose) throw new Error("This task has no image purpose.");
      return createMissingImage({
        actorId: input.actorId,
        detail: await detail(task.characterId),
        purpose: task.purpose,
        name: task.name,
      });
    }
    // 第一次用列表的版本；重试时列表可能已过期，重读后仍由服务端做 CAS 校验。
    const entityVersion = task.attempts > 0
      ? (await detail(task.characterId, true)).serving?.version ?? item.serving.version
      : item.serving.version;
    return submitServingCommand({
      characterId: task.characterId,
      action: action.kind === "archive" ? "retire" : action.kind,
      entityVersion,
      sleep: input.sleep,
    });
  };
}
