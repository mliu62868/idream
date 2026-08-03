import type { ChatSession, Prisma } from "../generated/client/client.js";
import type { ChatPrismaClient } from "./db.js";
import { ChatError } from "./errors.js";

// SPEC: 会话访问前置条件的唯一实现 —— "会话在吗 / 是这个用户的吗 / 它的生命周期
//       允许这次操作吗"，三问一次答完，不满足就按调用点声明的映射抛错。
//
// INTENT: 这条规则此前在 service.ts 里手抄了 10 遍，而且抄出了**三种不同的状态谓词**
//       （`status !== "active"` / `status === "deleted"` / 干脆不查）和**三种不同的
//       错误映射**（404 session_not_found / 403 forbidden 后接 409 session_not_active /
//       全部 409）。分歧本身多半是有意的 —— sendMessage 的入参是 sessionId，用 404
//       盖住"存在但不是你的"；editUserMessage 的入参是 messageId，存在性已经泄漏了，
//       再假装 404 没有意义。但这些理由当时只活在写代码那个人的脑子里：十个调用点长得
//       几乎一样，没人能一眼看出哪三个不一样、为什么不一样。
//       这个模块**不改任何一条既有映射**，只把它从手抄代码变成显式声明的参数 —— 分歧
//       从此是 grep 得到的，不是考古得到的。
//
// INVARIANT: `status` 和 `deletedAt` 是同一个事实的两个字段。privacy.ts 的会话擦除是
//       唯一写入方，两个字段同事务写，所以它们今天不会不一致。`lifecycleOf` 是唯一
//       读取方，且**任一字段说已删就是已删** —— 将来谁只写了一个字段，读侧也不会把
//       一个半删的会话当成活的。admin.ts 和 file-mutations.ts 的查询早就是这么读的，
//       这里只是把该约定收成一处。

/** 会话生命周期。`status` 与 `deletedAt` 的唯一解释入口。 */
export type SessionLifecycle = "active" | "archived" | "deleted";

/** 操作要求的最低生命周期。`any` 意味着这个操作对已归档/已删除的会话同样合法。 */
export type SessionRequirement = "active" | "not_deleted" | "any";

/**
 * 前置条件不满足时对外呈现的形状。三种映射各自对应一类入口，选哪种取决于
 * **调用方的入参是否已经泄漏了会话的存在性**。
 */
export type SessionDenial =
  /** 入参是 sessionId：一律 404，不区分"不存在"和"不是你的"。 */
  | { readonly kind: "not_found" }
  /** 入参是 messageId（存在性已由消息查询泄漏）：不是你的 → 403；生命周期不合 → 409。 */
  | { readonly kind: "owner_forbidden"; readonly forbiddenMessage: string }
  /** 事务内复查：外层已经放行过一次，此处任何不满足都只可能是并发改动 → 409。 */
  | { readonly kind: "conflict" };

type SessionReader = ChatPrismaClient | Prisma.TransactionClient;

export function lifecycleOf(
  session: Pick<ChatSession, "status" | "deletedAt">,
): SessionLifecycle {
  if (session.status === "deleted" || session.deletedAt) return "deleted";
  return session.status === "active" ? "active" : "archived";
}

function satisfies(lifecycle: SessionLifecycle, requirement: SessionRequirement) {
  if (requirement === "any") return true;
  if (requirement === "not_deleted") return lifecycle !== "deleted";
  return lifecycle === "active";
}

function denyMissingOrForeign(denial: SessionDenial): never {
  if (denial.kind === "owner_forbidden") {
    throw new ChatError("forbidden", denial.forbiddenMessage, 403);
  }
  if (denial.kind === "conflict") {
    throw new ChatError("session_not_active", "session is not active", 409);
  }
  throw new ChatError("session_not_found", "session not found", 404);
}

function denyLifecycle(denial: SessionDenial): never {
  // owner_forbidden 只覆盖归属；生命周期不合在这两类入口上一律是 409。
  if (denial.kind === "not_found") {
    throw new ChatError("session_not_found", "session not found", 404);
  }
  throw new ChatError("session_not_active", "session is not active", 409);
}

/**
 * 对**已经读出来**的会话行断言访问权。事务内复查往往和别的查询一起 `Promise.all`
 * 批量取回，那些调用点不该为了走同一条规则而多发一次查询 —— 所以规则本体是纯的，
 * `requireSession` 只是它加一次读。
 */
export function assertSessionAccess(
  session: ChatSession | null,
  input: { readonly userId: string },
  policy: { readonly require: SessionRequirement; readonly denial: SessionDenial },
): asserts session is ChatSession {
  if (!session || session.userId !== input.userId) denyMissingOrForeign(policy.denial);
  if (!satisfies(lifecycleOf(session), policy.require)) denyLifecycle(policy.denial);
}

/**
 * 读出会话并断言调用方有权按 `require` 操作它。返回的会话保证满足 `require`。
 *
 * 传 `db` 为事务客户端即得到事务内复查：durable 写入路径在事务外读一次、事务内再读
 * 一次，两次用的是同一条规则 —— 这正是此前最容易抄歪的地方。
 */
export async function requireSession(
  db: SessionReader,
  input: { readonly sessionId: string; readonly userId: string },
  policy: { readonly require: SessionRequirement; readonly denial: SessionDenial },
): Promise<ChatSession> {
  const session = await db.chatSession.findUnique({ where: { id: input.sessionId } });
  assertSessionAccess(session, input, policy);
  return session;
}
