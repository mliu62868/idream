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
};

const FALLBACK: Omit<FailureReason, "code"> = {
  title: "Unknown error",
  hint: "Share the error code with engineering",
  severity: "engineering",
};

export function resolveFailureReason(code: string | null | undefined): FailureReason {
  const key = (code ?? "").trim().toLowerCase();
  const hit = key ? TABLE[key] : undefined;
  return { code: code ?? "", ...(hit ?? FALLBACK) };
}
