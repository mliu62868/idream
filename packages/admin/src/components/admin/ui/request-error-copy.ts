import { AdminV2RequestError, apiErrorFieldNames } from "@/lib/admin-v2-api";

// SPEC: 把一次 authority 失败翻译成运营看得懂的两句话 + 一份原样保留的技术详情。
// INTENT: 运营面对的是「我刚点的退款到底退了没、现在该干什么」，authority 抛的
//         `conflict: Character version changed` 回答不了这两个问题里的任何一个。
// INVARIANT: headline / nextStep 是 i18n key，渲染处 t() 一次；technical 里的东西一个都不加工。
export type OperatorErrorCopy = {
  /** 发生了什么。 */
  headline: string;
  /** 下一步该做什么。 */
  nextStep: string;
  /** nextStep 的插值实参。 */
  nextStepValues?: Record<string, string>;
  technical: {
    code: string | null;
    status: number | null;
    requestId: string | null;
    /** authority 的原文，一个字不改——工程要拿它去对日志。 */
    message: string;
    details?: unknown;
  };
};

type Copy = { headline: string; nextStep: string };

// SPEC: key 是 packages/main/src/server/lib/errors.ts 的 AppErrorCode 全集，没有别的来源。
// INVARIANT: 5xx 与网络故障一律不承诺「没有写入」——那是猜的。只说「先去核对当前状态」。
//            这条是「假 reason 禁令」在错误文案上的落点：宁可说不知道，不许编一个原因。
const COPY_BY_CODE: Record<string, Copy> = {
  bad_request: {
    headline: "The authority rejected these values.",
    nextStep: "Correct the input and submit again — nothing was written.",
  },
  unauthorized: {
    headline: "Your admin session is no longer valid.",
    nextStep: "Sign in again, then repeat the action — nothing was written.",
  },
  forbidden: {
    headline: "Your account does not hold the permission this action needs.",
    nextStep:
      "Ask an admin owner to grant it, or hand the task to someone who already has it.",
  },
  payment_required: {
    headline: "The target account does not have enough balance for this action.",
    nextStep: "Top the balance up or lower the amount, then try again.",
  },
  not_found: {
    headline: "This record no longer exists in the authority.",
    nextStep: "Refresh the list — someone may have removed it while this page was open.",
  },
  gone: {
    headline: "This record has been permanently removed.",
    nextStep: "Refresh the list; it can no longer be acted on.",
  },
  // SPEC: 409 的默认解释**不是**版本竞争。
  // INTENT: 本仓 admin-v2 有 190 处 `Errors.conflict`，只有 9 处带结构化 details；其余绝大多数
  //         是「前置条件不满足」（must / only / already has a terminal / is unavailable），
  //         不是并发写入。此前默认文案一律说「有人改过这条记录，刷新后重新判断」——
  //         对这批冲突刷新一万次也不会变，而且这正是本文件自己写的「假 reason 禁令」所禁的：
  //         编一个原因比说不知道更糟。版本竞争的文案改为需要正面证据才启用（见 CONFLICT_VERSION_RACE）。
  conflict: {
    headline: "The authority refused this action — a precondition was not met.",
    nextStep:
      "Check the current state and open the technical details for the authority's reason before retrying.",
  },
  rate_limited: {
    headline: "Too many admin requests in a short window.",
    nextStep: "Wait a moment and try again — nothing was written.",
  },
  unavailable: {
    headline: "The authority did not answer.",
    nextStep:
      "Check this record's current state before retrying; whether the write landed is unknown.",
  },
  internal: {
    headline: "The authority hit an internal error.",
    nextStep:
      "Check this record's current state before retrying, then send the technical details to engineering.",
  },
};

// SPEC: 没有 code 时按 HTTP 状态兜底（代理层、网关、非 JSON 响应都可能只剩状态码）。
const CODE_BY_STATUS: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  402: "payment_required",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  410: "gone",
  429: "rate_limited",
  500: "internal",
  502: "unavailable",
  503: "unavailable",
  504: "unavailable",
};

// SPEC: 映射不到任何已知码时的体面兜底——不编原因，只说「没完成」并把详情推给工程。
const UNMAPPED: Copy = {
  headline: "This action did not complete.",
  nextStep:
    "The cause is not identified — copy the technical details and send them to engineering.",
};

const OFFLINE: Copy = {
  headline: "The browser could not reach the admin authority.",
  nextStep:
    "Check the connection and try again; whether the request arrived is unknown.",
};

// SPEC: 校验失败时，把被拒的字段名顶到 nextStep 上。
// INTENT: 「改正后重新提交」在一个七格表单上等于没说。字段名是机器标识但足够短、能插进译文，
//         而 Zod 那句英文原话留在技术详情里——中文后台的首屏不出现英文。
const FIELD_REJECTED: Copy = {
  headline: "The authority rejected these values.",
  nextStep: "These fields were rejected: {fields}. Correct them and submit again — nothing was written.",
};

const CASE_ASSIGNMENT_BLOCKED: Copy = {
  headline: "This case is resolved or closed.",
  nextStep: "Reopen this case before changing its assignment.",
};

// INVARIANT: blocker 不保证可覆盖、刷新无效或事务未写入；这些结论必须由具体权威提供。
const CONFLICT_PRECONDITION: Copy = {
  headline: "The authority refused this action: its precondition is not met.",
  nextStep:
    "Open the technical details for the authority's blocker and required action. Check the current state before retrying.",
};

// INVARIANT: 请求带版本号只证明启用了乐观锁；只有权威明确报出版本不匹配才使用竞争文案。
const CONFLICT_VERSION_RACE: Copy = {
  headline: "Someone changed this record before your action landed.",
  nextStep: "Refresh to load the current version, then decide again.",
};

const SUPPORT_CASE_SUPERSEDED: Copy = {
  headline: "This request has a newer support case.",
  nextStep: "Open case {caseId} and reopen it there. This historical case was not changed.",
};

export function operatorErrorCopy(cause: unknown): OperatorErrorCopy {
  const message = errorText(cause);
  if (cause instanceof AdminV2RequestError) {
    const code = cause.code ?? CODE_BY_STATUS[cause.status] ?? null;
    const fields = code === "bad_request" ? apiErrorFieldNames(cause.details) : [];
    const terminalAssignment = code === "conflict" &&
      message === "Case cannot be assigned from its present state" &&
      cause.details !== null && typeof cause.details === "object" &&
      "status" in cause.details &&
      (cause.details.status === "resolved" || cause.details.status === "closed");
    const currentCaseId = code === "conflict" &&
      message === "A newer support Case owns this request; reopen that Case instead" &&
      cause.details !== null && typeof cause.details === "object" &&
      "currentCaseId" in cause.details && typeof cause.details.currentCaseId === "string"
      ? cause.details.currentCaseId : null;
    const precondition = code === "conflict" &&
      cause.details !== null && typeof cause.details === "object" &&
      "blocker" in cause.details && typeof cause.details.blocker === "string";
    const versionRace = precondition && (cause.details as { blocker: string }).blocker === "version_mismatch";
    return {
      ...(currentCaseId ? SUPPORT_CASE_SUPERSEDED : terminalAssignment ? CASE_ASSIGNMENT_BLOCKED : versionRace ? CONFLICT_VERSION_RACE : precondition ? CONFLICT_PRECONDITION : fields.length > 0 ? FIELD_REJECTED : (COPY_BY_CODE[code ?? ""] ?? UNMAPPED)),
      ...(fields.length > 0 ? { nextStepValues: { fields: fields.join("、") } } : {}),
      ...(currentCaseId ? { nextStepValues: { caseId: currentCaseId } } : {}),
      technical: {
        code: cause.code ?? null,
        status: cause.status,
        requestId: cause.requestId ?? null,
        message,
        ...(cause.details === undefined ? {} : { details: cause.details }),
      },
    };
  }
  return {
    // INTENT: fetch 自己抛的 TypeError 是「请求没发出去/连接断了」，跟 authority 拒绝是两回事。
    ...(cause instanceof TypeError ? OFFLINE : UNMAPPED),
    technical: { code: null, status: null, requestId: null, message },
  };
}

/** 「技术详情」折叠区里那一段可以一键复制给工程的纯文本。 */
export function technicalDetailText(technical: OperatorErrorCopy["technical"]) {
  return [
    technical.code ? `code: ${technical.code}` : null,
    technical.status === null ? null : `status: ${technical.status}`,
    technical.requestId ? `requestId: ${technical.requestId}` : null,
    `message: ${technical.message}`,
    technical.details === undefined ? null : `details: ${JSON.stringify(technical.details)}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/** 映射表能产出的全部 i18n key —— 由 request-error-copy.test.ts 逐个核对中文存在。 */
export const OPERATOR_ERROR_COPY_KEYS: readonly string[] = [
  ...Object.values(COPY_BY_CODE),
  UNMAPPED,
  OFFLINE,
  FIELD_REJECTED,
  CASE_ASSIGNMENT_BLOCKED,
  SUPPORT_CASE_SUPERSEDED,
  CONFLICT_PRECONDITION,
  CONFLICT_VERSION_RACE,
].flatMap((copy) => [copy.headline, copy.nextStep]);

function errorText(cause: unknown) {
  if (cause instanceof Error && cause.message) return cause.message;
  return typeof cause === "string" && cause ? cause : "No error text was returned.";
}
