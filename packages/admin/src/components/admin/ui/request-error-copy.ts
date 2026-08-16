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
  /** nextStep 的插值实参（目前只有校验失败的字段名列表）。 */
  nextStepValues?: Record<string, string>;
  technical: {
    code: string | null;
    status: number | null;
    requestId: string | null;
    /** authority 的原文，一个字不改——工程要拿它去对日志。 */
    message: string;
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
  conflict: {
    headline: "Someone changed this record before your action landed.",
    nextStep: "Refresh to load the current version, then decide again.",
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

export function operatorErrorCopy(cause: unknown): OperatorErrorCopy {
  const message = errorText(cause);
  if (cause instanceof AdminV2RequestError) {
    const code = cause.code ?? CODE_BY_STATUS[cause.status] ?? null;
    const fields = code === "bad_request" ? apiErrorFieldNames(cause.details) : [];
    return {
      ...(fields.length > 0 ? FIELD_REJECTED : (COPY_BY_CODE[code ?? ""] ?? UNMAPPED)),
      ...(fields.length > 0 ? { nextStepValues: { fields: fields.join("、") } } : {}),
      technical: {
        code: cause.code ?? null,
        status: cause.status,
        requestId: cause.requestId ?? null,
        message,
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
].flatMap((copy) => [copy.headline, copy.nextStep]);

function errorText(cause: unknown) {
  if (cause instanceof Error && cause.message) return cause.message;
  return typeof cause === "string" && cause ? cause : "No error text was returned.";
}
