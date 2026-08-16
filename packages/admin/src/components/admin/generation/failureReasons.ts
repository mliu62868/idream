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
// RULE: 只登记能在生产代码里查到发出点、且能读出含义的码。查不到就让它走兜底——
//       一条编出来的原因比一句"把错误码给工程"更贵，运营会照着它做错误的动作。
//       每条都注明出处，改后端时能顺着找回来。
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
  // server/ai/local-pipeline.ts:391 —— 供应器执行租约到期却没有终态记录。
  // hint 用它自己写的 operatorGuidance，不另行发明。
  stale_provider_outcome: {
    title: "Provider outcome never settled",
    hint: "Reconcile the provider request before settling, refunding, or retrying",
    severity: "waiting",
  },
  // server/ai/generation-transport-execution.ts:161 —— 调用完成了，但终态证据没落库。
  terminal_record_persist_failed: {
    title: "Result was not durably recorded",
    hint: "Reconcile provider output before retrying — the invocation completed without durable evidence",
    severity: "waiting",
  },
  // server/ai/local-pipeline.ts:1104 (GenerationJobEvent.type) —— 供应器结果无法判定。
  provider_outcome_unknown: {
    title: "Provider outcome is unknown",
    hint: "Reconcile the provider request before settlement or business retry",
    severity: "waiting",
  },
  // shared/media/generated-image-sanity.ts:20 —— 空白/损坏/拼贴图被质检拦下。
  // hint 取 admin-v2/creative/run-read.ts:69 给运营写的那句。
  asset_quality_failed: {
    title: "Image failed the quality check",
    hint: "Blank, collaged, or corrupt output is discarded — adjust the prompt and generate again",
    severity: "retry",
  },
  // admin-v2/creative/run-read.ts:64 —— 没有更具体的码时的兜底码（不是"未知码"）。
  generation_failed: {
    title: "No reviewable image was produced",
    hint: "Load this run's parameters, adjust them, and generate again",
    severity: "retry",
  },
};

const FALLBACK: Omit<FailureReason, "code"> = {
  title: "Unknown error",
  hint: "Share the error code with engineering",
  severity: "engineering",
};

export function resolveFailureReason(code: string | null | undefined): FailureReason {
  const key = (code ?? "").trim().toLowerCase();
  const hit = key && Object.hasOwn(TABLE, key) ? TABLE[key] : undefined;
  return { code: code ?? "", ...(hit ?? FALLBACK) };
}
