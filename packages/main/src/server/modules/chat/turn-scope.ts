import type { ChatTurn, ChatTurnAttachment, GroupConversation, Prisma, RecentChat } from "@prisma/client";
import { Errors } from "@/server/lib/errors";

// SPEC: 产品 Turn 变更范围的唯一取锁入口。调用方交出的是**身份**
// (sessionId / turnId / attachmentId)，不是取锁指令，所以「先锁 Turn 再锁 user」
// 这种写法在类型上就写不出来。
//
// INVARIANT: 锁序恒为 users → group_conversations → recent_chats → chat_turns
//   → chat_turn_attachments。turn-ledger.ts `commitChatTerminal` 记录过反序的
//   代价：memory commit 期间一个 user-first 的写会与 Turn-first 的写死锁。
//   ourdream/generation-job-authority.ts 曾把同一条规则抄成注释
//   (“Match Chat mutation order”)，复述的规则不会随本文件一起演进。
//
// INTENT: 上锁前的身份解析全部是未上锁读，只用来确定阶梯有哪几级；上锁后每一行
//   重新读一次并复验归属。未上锁读到的任何事实都不进入返回值，调用方因此拿不到
//   「没上锁就读出来的 Turn」。
export const CHAT_SCOPE_LOCK_ORDER = [
  "users",
  "group_conversations",
  "recent_chats",
  "chat_turns",
  "chat_turn_attachments",
] as const;

declare const lockedChatRow: unique symbol;

/**
 * SPEC: 只有 {@link lockChatScope} 能产出。写附件状态的入口要求这个类型，
 * 于是「不持行锁改附件状态」是编译错误，而不是一条靠人记住的约定。
 */
export type LockedChatTurnAttachment = ChatTurnAttachment & {
  readonly [lockedChatRow]: "chat_turn_attachments";
};

export type LockedChatTurn = ChatTurn & { readonly [lockedChatRow]: "chat_turns" };

/** 入口只允许一个，阶梯的其余层级由本 module 反查，调用方无从指定顺序。 */
export type ChatScopeAnchor =
  | { readonly session: string }
  | { readonly turn: string }
  | { readonly attachment: string };

export type ChatScopeExpectation = {
  /** 会话必须仍 pin 在这个角色上，生成请求的身份 pin 才成立。显式 null 表示必须无角色。 */
  readonly characterId?: string | null;
  /** Turn 必须仍停在这一次 attempt。 */
  readonly attempt?: number;
  /** Turn 的产品回复必须落在这些状态里。 */
  readonly assistantStatus?: readonly string[];
  /**
   * INVARIANT: 一条已锁的工具效果附件，其 metadata.attempt 必须等于所属 Turn 的
   * attempt，否则这条附件属于一次被 regenerate 丢弃的 attempt。重绑 attempt 的
   * 那一个调用方（tool-effect 的 replay rebind）不传此项，因为它要写的正是差异本身。
   */
  readonly attachmentAttemptMatchesTurn?: boolean;
  /** 冲突时呈现给产品的原话；不传则用通用文案。 */
  readonly conflictMessage?: string;
};

export type ChatScopeRequest = {
  readonly userId: string;
  readonly at: ChatScopeAnchor;
  /** 默认拒绝已删除会话。删除/清理链路显式放行。 */
  readonly allowDeletedSession?: boolean;
  readonly expect?: ChatScopeExpectation;
};

export type LockedChatScope = {
  readonly userId: string;
  readonly group: GroupConversation | null;
  readonly session: RecentChat;
  readonly turn: LockedChatTurn | null;
  readonly attachment: LockedChatTurnAttachment | null;
};

type ScopeIdentity = {
  readonly sessionId: string;
  readonly groupId: string | null;
  readonly turnId: string | null;
  readonly attachmentId: string | null;
};

/**
 * 按固定锁序取下这次产品 Turn 变更要动的每一行，返回锁内重读的行。
 *
 * INTENT: 归属、attempt 匹配、assistantStatus 判定都收在这里。生成模块以前把这三
 * 条各自抄了一遍；抄写版本和本体一旦漂移，谁也不会发现。
 */
export async function lockChatScope(
  tx: Prisma.TransactionClient,
  request: ChatScopeRequest,
): Promise<LockedChatScope> {
  const conflict = (detail: string) =>
    Errors.conflict(request.expect?.conflictMessage ?? detail);
  const identity = await resolveScopeIdentity(tx, request);

  await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${request.userId} FOR UPDATE`;
  if (identity.groupId) {
    await tx.$queryRaw`SELECT id FROM "group_conversations" WHERE id = ${identity.groupId} FOR UPDATE`;
  }
  await tx.$queryRaw`SELECT "sessionId" FROM "recent_chats" WHERE "sessionId" = ${identity.sessionId} FOR UPDATE`;
  if (identity.turnId) {
    await tx.$queryRaw`SELECT id FROM "chat_turns" WHERE id = ${identity.turnId} FOR UPDATE`;
  }
  if (identity.attachmentId) {
    await tx.$queryRaw`SELECT id FROM "chat_turn_attachments" WHERE id = ${identity.attachmentId} FOR UPDATE`;
  }

  const session = await tx.recentChat.findFirst({
    where: { sessionId: identity.sessionId, userId: request.userId },
  });
  if (!session) throw Errors.notFound("Chat session not found");
  // 未上锁读出来的 groupId 若在上锁前改过，这次取的锁就不是完整阶梯。
  if (session.groupId !== identity.groupId) {
    throw conflict("This chat moved between conversations before it could be locked");
  }
  if (!request.allowDeletedSession && session.status === "deleted") {
    throw Errors.gone("Chat session is no longer available");
  }
  const expect = request.expect;
  if (expect?.characterId !== undefined && session.characterId !== expect.characterId) {
    throw conflict("This chat is no longer pinned to the original character");
  }
  const group = session.groupId
    ? await tx.groupConversation.findFirst({ where: { id: session.groupId, userId: request.userId } })
    : null;
  if (session.groupId && !group) throw Errors.notFound("Group conversation not found");

  let turn: LockedChatTurn | null = null;
  if (identity.turnId) {
    const row = await tx.chatTurn.findFirst({
      where: { id: identity.turnId, sessionId: session.sessionId },
    });
    if (!row) throw Errors.notFound("Chat turn not found");
    if (expect?.attempt !== undefined && row.attempt !== expect.attempt) {
      throw conflict("This chat reply advanced to another attempt");
    }
    if (expect?.assistantStatus && !expect.assistantStatus.includes(row.assistantStatus)) {
      throw conflict("This chat reply is no longer in the expected state");
    }
    turn = row as LockedChatTurn;
  }

  let attachment: LockedChatTurnAttachment | null = null;
  if (identity.attachmentId) {
    const row = await tx.chatTurnAttachment.findFirst({
      where: { id: identity.attachmentId, turnId: identity.turnId ?? undefined },
    });
    if (!row) throw Errors.notFound("Chat attachment not found");
    if (expect?.attachmentAttemptMatchesTurn && turn && attachmentAttempt(row.metadata) !== turn.attempt) {
      throw conflict("This chat attachment belongs to a discarded attempt");
    }
    attachment = row as LockedChatTurnAttachment;
  }

  return { userId: request.userId, group, session, turn, attachment };
}

// 未上锁读，只回答「阶梯有哪几级」。任何被它读出的业务事实都在上锁后重读。
async function resolveScopeIdentity(
  tx: Prisma.TransactionClient,
  request: ChatScopeRequest,
): Promise<ScopeIdentity> {
  const sessionOwnership = { userId: request.userId };
  if ("session" in request.at) {
    const session = await tx.recentChat.findFirst({
      where: { sessionId: request.at.session, ...sessionOwnership },
      select: { sessionId: true, groupId: true },
    });
    if (!session) throw Errors.notFound("Chat session not found");
    return { sessionId: session.sessionId, groupId: session.groupId, turnId: null, attachmentId: null };
  }
  if ("turn" in request.at) {
    const turn = await tx.chatTurn.findFirst({
      where: { id: request.at.turn, session: sessionOwnership },
      select: { id: true, sessionId: true, session: { select: { groupId: true } } },
    });
    if (!turn) throw Errors.notFound("Chat turn not found");
    return { sessionId: turn.sessionId, groupId: turn.session.groupId, turnId: turn.id, attachmentId: null };
  }
  const attachment = await tx.chatTurnAttachment.findFirst({
    where: { id: request.at.attachment, turn: { session: sessionOwnership } },
    select: { id: true, turnId: true, turn: { select: { sessionId: true, session: { select: { groupId: true } } } } },
  });
  if (!attachment) throw Errors.notFound("Chat attachment not found");
  return {
    sessionId: attachment.turn.sessionId,
    groupId: attachment.turn.session.groupId,
    turnId: attachment.turnId,
    attachmentId: attachment.id,
  };
}

/** 历史上附件把 attempt 写在根上或 effect 下，两处都要认。 */
export function attachmentAttempt(metadata: Prisma.JsonValue): number {
  const root = record(metadata);
  const value = root?.attempt ?? record(root?.effect)?.attempt;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 1;
}

/**
 * INTENT: 同一事务里刚 INSERT 的行已被该事务独占持有，与再补一次 FOR UPDATE 等价。
 * 这是 {@link LockedChatTurnAttachment} 唯一的另一条产出路径，只给附件创建入口用。
 */
export function attachmentLockedByInsert(row: ChatTurnAttachment): LockedChatTurnAttachment {
  return row as LockedChatTurnAttachment;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
