// SPEC: 前端 SSoT——把生成失败的机器码/failureMode/verificationStatus 翻成运营看得懂的
//       人话标题 + 建议动作。纯前端，不依赖后端返回结构。
// INTENT: 未知码必须走兜底，绝不把原始码漏到运营首屏（原码只在 EngineeringDetails 展开可见）。
// INVARIANTS: resolveFailureReason 对任意输入都返回一个 FailureReason（永不 undefined）。
// EXAMPLE: resolveFailureReason("timeout") → { code:"timeout", title:"Generation timed out", hint:"Safe to retry", severity:"retry" }

export type FailureSeverity = "retry" | "engineering" | "waiting";

export type FailureReason = {
  code: string; // 原始机器码，保留给 EngineeringDetails 展开
  title: string; // i18n key（人话标题）
  hint: string; // i18n key（建议动作）
  severity: FailureSeverity;
};

// key = 机器码 / failureMode / verificationStatus（小写下划线）。title/hint 存 i18n key。
const TABLE: Record<string, Omit<FailureReason, "code">> = {
  missing_runtime_components: {
    title: "Model files not ready",
    hint: "Missing runtime components — needs engineering",
    severity: "engineering",
  },
  missing_flux2_klein_reference_runtime_components: {
    title: "Model files not ready",
    hint: "Missing runtime components — needs engineering",
    severity: "engineering",
  },
  timeout: { title: "Generation timed out", hint: "Safe to retry", severity: "retry" },
  backend_unreachable: {
    title: "Backend unreachable",
    hint: "Check backend health — needs engineering",
    severity: "engineering",
  },

  // --- generation pipeline (packages/main/src/server/ai/*) ---
  // INVARIANT: 这一段每个 key 都能在 main 的非测试代码里找到写入点。只映射真存在的码——
  // 编一个不存在的码进来，等于给运营一个永远不会发生的解释。
  provider_timeout: {
    title: "Provider did not answer in time",
    hint: "Safe to retry",
    severity: "retry",
  },
  provider_failed: {
    title: "Provider rejected the request",
    hint: "Safe to retry; if it repeats, needs engineering",
    severity: "retry",
  },
  provider_unavailable: {
    title: "Provider is unavailable",
    hint: "Wait for capacity, then retry",
    severity: "retry",
  },
  provider_blocked: {
    title: "Provider refused to run this request",
    hint: "Adjust the request before retrying",
    severity: "retry",
  },
  provider_policy_blocked: {
    title: "Provider policy refused this request",
    hint: "Adjust the request before retrying",
    severity: "retry",
  },
  provider_outcome_unknown: {
    title: "Provider outcome is unknown",
    hint: "Reconcile before retrying — a duplicate may be produced",
    severity: "engineering",
  },
  stale_provider_outcome: {
    title: "Provider answered after this job was already closed",
    hint: "No action needed — the late result was discarded",
    severity: "waiting",
  },
  stale_timeout: {
    title: "Job timed out while waiting for the provider",
    hint: "Safe to retry",
    severity: "retry",
  },
  late_worker_failure: {
    title: "Worker reported failure after the job was closed",
    hint: "No action needed — the late result was discarded",
    severity: "waiting",
  },
  delivery_failed: {
    title: "Image was produced but could not be delivered",
    hint: "Check storage and delivery — needs engineering",
    severity: "engineering",
  },
  terminal_record_persist_failed: {
    title: "Final result could not be saved",
    hint: "Check the database — needs engineering",
    severity: "engineering",
  },
  serialization_failure: {
    title: "Two writes collided on this job",
    hint: "Safe to retry",
    severity: "retry",
  },
  operator_cancelled: {
    title: "An operator cancelled this job",
    hint: "No action needed",
    severity: "waiting",
  },
  preserve_on_replay: {
    title: "Replay kept the earlier outcome",
    hint: "No action needed",
    severity: "waiting",
  },

  // --- voice + coin balance (modules/ourdream/voice-clip.ts, providers/voice/*) ---
  voice_request_failed: {
    title: "Voice provider rejected the request",
    hint: "Safe to retry; if it repeats, needs engineering",
    severity: "retry",
  },
  allowance_exhausted: {
    title: "The customer's allowance is used up",
    hint: "Waiting on a reset or a top-up — not a fault",
    severity: "waiting",
  },
  insufficient_dreamcoins_after_synthesis: {
    title: "The customer ran out of Dreamcoins mid-generation",
    hint: "Waiting on a top-up — not a fault",
    severity: "waiting",
  },

  // --- creative runs + character release ---
  generation_failed: {
    title: "The generation step failed",
    hint: "Open the job for its own failure reason",
    severity: "engineering",
  },
  unsupported_command: {
    title: "This command is not supported here",
    hint: "Needs engineering — the console offered an action the authority rejects",
    severity: "engineering",
  },
  internal: {
    title: "The authority hit an internal error",
    hint: "Send the error code to engineering",
    severity: "engineering",
  },
};

const FALLBACK: Omit<FailureReason, "code"> = {
  title: "Unknown error",
  hint: "Share the error code with engineering",
  severity: "engineering",
};

/** 表里能产出的全部 i18n key —— 由 failureReasons.test.ts 逐个核对中文存在。
 * TRAP: 它们只经 t(reason.title) / t(reason.hint) 动态取值，i18n-completeness 的字面量
 *       扫描看不见，漏译不会有任何测试变红——除了那一个。 */
export const FAILURE_REASON_COPY_KEYS: readonly string[] = [
  ...Object.values(TABLE),
  FALLBACK,
].flatMap((reason) => [reason.title, reason.hint]);

export function resolveFailureReason(code: string | null | undefined): FailureReason {
  const key = (code ?? "").trim().toLowerCase();
  const hit = key && Object.hasOwn(TABLE, key) ? TABLE[key] : undefined;
  return { code: code ?? "", ...(hit ?? FALLBACK) };
}
