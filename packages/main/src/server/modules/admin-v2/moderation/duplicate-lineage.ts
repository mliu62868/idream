// SPEC: MediaAsset.metadata 里的「独立复本谱系」—— 一张图是谁从哪张图复制出来的。
// INTENT: 队列投影和媒体裁决都要读它，且两边必须对「什么算合法谱系」用同一个判断，
//         否则队列会列出裁决拒绝受理的行。
export function duplicateLineage(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const lineage = (value as Record<string, unknown>).duplicateLineage;
  if (!lineage || typeof lineage !== "object" || Array.isArray(lineage)) return null;
  const record = lineage as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.sourceAssetId !== "string" ||
    typeof record.sourceCharacterId !== "string" ||
    typeof record.duplicateCharacterId !== "string" ||
    typeof record.duplicatedByUserId !== "string"
  ) {
    return null;
  }
  return {
    sourceAssetId: record.sourceAssetId,
    sourceCharacterId: record.sourceCharacterId,
    duplicateCharacterId: record.duplicateCharacterId,
    duplicatedByUserId: record.duplicatedByUserId,
  };
}
