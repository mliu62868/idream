// SPEC: 把生成失败的内部错误码翻译成读者看得懂的一句话（主站文案是英文）。
// INTENT: 失败的任务过去直接把内部标识符渲染给用户 —— "Failed: backend_error"、
//   "Failed: operator_confirmed_provider_failure"。前者是黑话，后者更糟：自动结算
//   的任务并没有运营参与过，那个码只是「unknown 已被确认为失败」的内部状态标记
//   （retry 闸门依赖它，不能改名），照字面读给用户就是假的。
// INVARIANT: 查不到的码一律回落成原码，绝不编一个理由 —— 宁可让用户看到一个陌生
//   的标识符去问客服，也不要给他一句听起来可信但不对的解释。
// INVARIANT: 「Your coins are back」这句只有在退款确实必然发生时才准写。它成立的
//   依据是 local-pipeline.ts 的终态处理：任何 failed / blocked 的已扣费任务都会
//   调 refundGenerationRequest 全额退回（未扣费的任务由结算 clamp 退 0）。所以
//   每一条失败文案都带这句；哪天那条路径变成有条件的，这里必须跟着改。
const FAILURE_COPY: Readonly<Record<string, string>> = {
  preparation_failed: "The generator could not start. Your coins are back — try again.",
  provider_timeout: "The generator timed out. Your coins are back — try again.",
  stale_timeout: "This job waited too long and was reclaimed. Your coins are back — try again.",
  operator_confirmed_provider_failure:
    "The generator never returned a result, so this was settled as failed. Your coins are back — try again.",
  backend_error: "The generator hit an error. Your coins are back — try again.",
  provider_failed: "The generator refused this request. Your coins are back — try again.",
  unknown_model:
    "That model is no longer available. Your coins are back — pick another model and try again.",
  identity_calibration_route_incompatible:
    "This character's identity references don't work with the selected model. Your coins are back — pick another model, or switch to Freeplay.",
  age_under_18:
    "This didn't pass the age safety check, so nothing was generated. Your coins are back.",
};

export function generationFailureCopy(errorCode: string | null): string | null {
  if (!errorCode) return null;
  return FAILURE_COPY[errorCode] ?? errorCode;
}
