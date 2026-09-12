import type { ChatTurnAttachment, Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import { attachmentLockedByInsert, type LockedChatTurn, type LockedChatTurnAttachment } from "./turn-scope";

// SPEC: 工具效果附件（聊天里的生成图片与生成视频）的唯一创建与迁移入口。
//
// INTENT: 图片以前在 modules/chat/tool-effect.ts 建、视频在
//   modules/ourdream/generation-job-authority.ts 建，同一个「工具效果」的诞生分居
//   两个 module，两边各自决定初始状态与 metadata 形状。现在只有一条出生路径。
//
// INVARIANT: 附件出生即 `requesting`，且只能沿下表迁移。非法迁移在 from 静态可知时
//   是编译错误，运行期一律 fail-closed 抛冲突，绝不静默写入。
export const TOOL_EFFECT_ATTACHMENT_STATUSES = [
  "requesting",
  "accepted",
  "completed",
  "failed",
  "blocked",
  "refunded",
  "cancelled",
] as const;
export type ToolEffectAttachmentStatus = (typeof TOOL_EFFECT_ATTACHMENT_STATUSES)[number];

export const TOOL_EFFECT_ATTACHMENT_KINDS = ["generated_image", "generated_video"] as const;
export type ToolEffectAttachmentKind = (typeof TOOL_EFFECT_ATTACHMENT_KINDS)[number];

// INTENT: `blocked` / `refunded` 不是设想中的扩展——ai/local-pipeline.ts 的终态投影
//   直接把 Generation Request 的终态状态名写进附件，实测会写出这两个值。表必须描述
//   真实系统，否则 fail-closed 会在正常终态上误伤。
export const TOOL_EFFECT_ATTACHMENT_TRANSITIONS = {
  // 预留的效果身份：要么被生成接纳，要么在接纳前就失败，从不直接跳到交付。
  requesting: ["accepted", "failed"],
  // 已接纳即已扣费：它的每一种去向都必须对应一次结算（交付或退款/取消）。
  accepted: ["completed", "failed", "blocked", "refunded", "cancelled"],
  completed: [],
  // 用户重试同一条聊天图片时复用这条效果身份，附件行不新建（image-retry）。
  // 只有这两个终态可以被重开：blocked / cancelled / completed 是最终答案。
  failed: ["accepted"],
  refunded: ["accepted"],
  blocked: [],
  cancelled: [],
} as const satisfies Record<ToolEffectAttachmentStatus, readonly ToolEffectAttachmentStatus[]>;

export type ToolEffectAttachmentTarget<From extends ToolEffectAttachmentStatus> =
  (typeof TOOL_EFFECT_ATTACHMENT_TRANSITIONS)[From][number];

export function isToolEffectAttachmentStatus(value: string): value is ToolEffectAttachmentStatus {
  return (TOOL_EFFECT_ATTACHMENT_STATUSES as readonly string[]).includes(value);
}

/**
 * 迁移是否合法。`from` 来自数据库的 String 列，所以运行期判定是真正的闸门；
 * 静态已知 `from` 的调用点还能多拿一层编译期检查。
 */
export function canTransitionToolEffectAttachment(from: string, to: ToolEffectAttachmentStatus): boolean {
  if (!isToolEffectAttachmentStatus(from)) return false;
  if (from === to) return true; // 幂等重放不是迁移。
  return (TOOL_EFFECT_ATTACHMENT_TRANSITIONS[from] as readonly string[]).includes(to);
}

export function assertToolEffectAttachmentTransition(from: string, to: ToolEffectAttachmentStatus): void {
  if (canTransitionToolEffectAttachment(from, to)) return;
  throw Errors.conflict("This chat attachment can no longer change to that state", {
    from,
    to,
  });
}

export type ToolEffectAttachmentCreate = {
  /** 确定性的效果身份；重放同一个效果必须落在同一行。 */
  readonly id: string;
  readonly turn: LockedChatTurn | { readonly id: string; readonly attempt: number };
  readonly kind: ToolEffectAttachmentKind;
  readonly attempt: number;
  readonly promptHint?: string | null;
  /** attempt 由本入口写入，调用方不再各写一份。 */
  readonly metadata?: Record<string, unknown>;
};

/**
 * 工具效果附件的唯一出生地。
 *
 * INVARIANT: 初始状态恒为 `requesting`，metadata.attempt 恒等于本次 attempt，
 * 于是 {@link lockChatScope} 的 `attachmentAttemptMatchesTurn` 对新生附件必然成立。
 */
export async function createToolEffectAttachment(
  tx: Prisma.TransactionClient,
  input: ToolEffectAttachmentCreate,
): Promise<LockedChatTurnAttachment> {
  if (input.turn.attempt !== input.attempt) {
    throw Errors.conflict("Tool effect does not belong to the active Chat attempt");
  }
  return attachmentLockedByInsert(await tx.chatTurnAttachment.create({
    data: {
      id: input.id,
      turnId: input.turn.id,
      kind: input.kind,
      status: "requesting",
      promptHint: input.promptHint ?? null,
      metadata: toJson({ ...(input.metadata ?? {}), attempt: input.attempt }),
    },
  }));
}

export type ToolEffectAttachmentTransition = {
  readonly to: ToolEffectAttachmentStatus;
  readonly generationJobId?: string | null;
  readonly mediaAssetId?: string | null;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly errorCode?: string | null;
  readonly metadata?: Record<string, unknown>;
};

/**
 * 附件状态的唯一写入口。
 *
 * INTENT: 入参要求一条 {@link LockedChatTurnAttachment}——只有 lockChatScope 能造出
 * 这个类型——所以「没拿到行锁就改状态」写不出来。ADR-13 §2.1.4 里那次 40 币退成
 * 80 币，根因就是六个调用点中有一个没上锁；修法是把锁收进权威函数而不是加检查。
 */
export async function transitionToolEffectAttachment(
  tx: Prisma.TransactionClient,
  attachment: LockedChatTurnAttachment,
  next: ToolEffectAttachmentTransition,
): Promise<ChatTurnAttachment> {
  assertToolEffectAttachmentTransition(attachment.status, next.to);
  return tx.chatTurnAttachment.update({
    where: { id: attachment.id },
    data: {
      status: next.to,
      ...(next.generationJobId !== undefined ? { generationJobId: next.generationJobId } : {}),
      ...(next.mediaAssetId !== undefined ? { mediaAssetId: next.mediaAssetId } : {}),
      ...(next.width !== undefined ? { width: next.width } : {}),
      ...(next.height !== undefined ? { height: next.height } : {}),
      ...(next.errorCode !== undefined ? { errorCode: next.errorCode } : {}),
      ...(next.metadata ? { metadata: toJson(next.metadata) } : {}),
    },
  });
}

/**
 * SPEC: `requesting → failed` 的无锁条件迁移——WHERE 子句本身就是守卫
 * (compare-and-set)，命中 0 行说明这条效果已被生成接纳或别的路径推进。
 *
 * INTENT: 预留失败发生在一次失败的生成调用之后，此时不持有任何聊天行锁，也不该为
 * 撤销预留去开一个事务。合法边仍然只在本 module 里声明一次，调用方写不出
 * `status: "completed"` 这种越界目标。
 *
 * @returns 是否真的撤销了这次预留；false 表示调用方必须重读当前事实。
 */
export async function abandonRequestedToolEffectAttachment(
  tx: Prisma.TransactionClient,
  input: { readonly id: string; readonly attempt: number; readonly errorCode: string },
): Promise<boolean> {
  assertToolEffectAttachmentTransition("requesting", "failed");
  const changed = await tx.chatTurnAttachment.updateMany({
    where: {
      id: input.id,
      status: "requesting",
      generationJobId: null,
      metadata: { path: ["attempt"], equals: input.attempt },
    },
    data: { status: "failed", errorCode: input.errorCode },
  });
  return changed.count > 0;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
