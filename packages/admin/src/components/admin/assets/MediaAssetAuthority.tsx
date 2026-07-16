import { CircleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

export const DEMO_OR_LEGACY_ASSET_LABEL = "Demo or legacy test asset";
export const NOT_PUBLISHABLE_LABEL = "Not publishable";

type MediaAssetAuthorityView = {
  readonly isSynthetic: boolean;
  readonly customerPublishable: boolean;
  readonly publishabilityReasons: readonly string[];
};

const demoOrLegacyReasons = new Set([
  "metadata_synthetic",
  "metadata_synthetic_marker_invalid",
  "pinned_provider_mock",
  "job_provider_mock",
  "latest_attempt_provider_mock",
]);

export function canApproveMediaAsset(
  asset: MediaAssetAuthorityView | null | undefined,
) {
  return asset?.customerPublishable === true;
}

function authorityLabel(asset: MediaAssetAuthorityView) {
  if (
    asset.isSynthetic ||
    asset.publishabilityReasons.some((reason) => demoOrLegacyReasons.has(reason))
  ) {
    return DEMO_OR_LEGACY_ASSET_LABEL;
  }
  if (asset.publishabilityReasons.includes("platform_asset_archived")) {
    return `${NOT_PUBLISHABLE_LABEL}: asset is archived`;
  }
  if (asset.publishabilityReasons.includes("platform_asset_rejected")) {
    return `${NOT_PUBLISHABLE_LABEL}: asset was rejected`;
  }
  if (
    asset.publishabilityReasons.some((reason) =>
      reason.includes("provider") || reason.includes("authority"),
    )
  ) {
    return `${NOT_PUBLISHABLE_LABEL}: generation authority is not trusted`;
  }
  return NOT_PUBLISHABLE_LABEL;
}

export function MediaAssetAuthorityNotice({
  asset,
  className,
}: {
  asset: MediaAssetAuthorityView | null | undefined;
  className?: string;
}) {
  if (!asset || asset.customerPublishable) return null;
  const label = authorityLabel(asset);
  return (
    <p
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md bg-[var(--ad-yellow-bg)] px-2 py-1 text-xs font-medium text-[var(--ad-yellow-text)]",
        className,
      )}
      role="status"
    >
      <CircleAlert aria-hidden="true" className="h-3.5 w-3.5" />
      {label}
    </p>
  );
}
