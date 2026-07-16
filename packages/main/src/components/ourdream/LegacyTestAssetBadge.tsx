type LegacyTestAssetBadgeProps = {
  className?: string;
  isSynthetic?: boolean;
};

export function LegacyTestAssetBadge({
  className = "",
  isSynthetic = false,
}: Readonly<LegacyTestAssetBadgeProps>) {
  if (!isSynthetic) return null;

  return (
    <span
      className={`pointer-events-none inline-flex items-center rounded-full border border-amber-100/70 bg-amber-300 px-2 py-1 text-[10px] font-black uppercase tracking-wide text-black shadow-lg ${className}`.trim()}
      data-testid="legacy-test-asset-badge"
      title="This is retained demo or legacy test media, not a verified generation result."
    >
      Demo / legacy test asset
    </span>
  );
}
