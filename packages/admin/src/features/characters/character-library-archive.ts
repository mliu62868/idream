// SPEC: 原因选填。服务端契约要求 reason ≥ 3，留空或太短时由客户端填默认值，不让运营手填。
export const CHARACTER_LIBRARY_ARCHIVE_DEFAULT_REASON = "Removed from the Character library";

export function operatorReasonOrDefault(reason: string, fallback: string) {
  const trimmed = reason.trim();
  return trimmed.length >= 3 ? trimmed : fallback;
}
