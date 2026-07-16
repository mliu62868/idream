type LegacyTestAssetBadgeProps = {
  isSynthetic?: boolean;
};

export function LegacyTestAssetBadge({
  isSynthetic = false,
}: Readonly<LegacyTestAssetBadgeProps>) {
  if (!isSynthetic) return null;

  return (
    <span
      className="pointer-events-none absolute right-2 top-2 z-20 inline-flex items-center rounded-full border border-amber-100/70 bg-amber-300 px-2 py-1 text-[10px] font-black uppercase tracking-wide text-black shadow-lg"
      data-testid="legacy-test-asset-badge"
      title="This is retained demo or legacy test media, not a verified generation result."
    >
      Demo / legacy test asset
    </span>
  );
}
