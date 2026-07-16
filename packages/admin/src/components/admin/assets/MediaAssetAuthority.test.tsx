import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DEMO_OR_LEGACY_ASSET_LABEL,
  MediaAssetAuthorityNotice,
  NOT_PUBLISHABLE_LABEL,
  canApproveMediaAsset,
} from "./MediaAssetAuthority";

describe("MediaAssetAuthority", () => {
  it("shows the operator-facing demo marker and disables approval", () => {
    const asset = {
      isSynthetic: true,
      customerPublishable: false,
      publishabilityReasons: ["metadata_synthetic"],
    };
    const html = renderToStaticMarkup(
      <MediaAssetAuthorityNotice asset={asset} />,
    );

    expect(DEMO_OR_LEGACY_ASSET_LABEL).toBe("Demo or legacy test asset");
    expect(html).toContain(DEMO_OR_LEGACY_ASSET_LABEL);
    expect(canApproveMediaAsset(asset)).toBe(false);
    expect(canApproveMediaAsset({
      isSynthetic: false,
      customerPublishable: true,
      publishabilityReasons: [],
    })).toBe(true);
  });

  it("does not mislabel a real archived asset as demo", () => {
    const asset = {
      isSynthetic: false,
      customerPublishable: false,
      publishabilityReasons: ["platform_asset_archived"],
    };
    const html = renderToStaticMarkup(
      <MediaAssetAuthorityNotice asset={asset} />,
    );

    expect(html).not.toContain(DEMO_OR_LEGACY_ASSET_LABEL);
    expect(html).toContain(`${NOT_PUBLISHABLE_LABEL}: asset is archived`);
    expect(canApproveMediaAsset(asset)).toBe(false);
  });

  it("labels a mock-provider asset as demo without corrupting isSynthetic", () => {
    const asset = {
      isSynthetic: false,
      customerPublishable: false,
      publishabilityReasons: ["job_provider_mock"],
    };
    const html = renderToStaticMarkup(
      <MediaAssetAuthorityNotice asset={asset} />,
    );

    expect(html).toContain(DEMO_OR_LEGACY_ASSET_LABEL);
  });

  it("is wired into both Image Library surfaces", () => {
    const listSource = readFileSync(
      new URL("./AssetsListPage.tsx", import.meta.url),
      "utf8",
    );
    const detailSource = readFileSync(
      new URL("./AssetsDetailPage.tsx", import.meta.url),
      "utf8",
    );

    expect(listSource).toContain("MediaAssetAuthorityNotice");
    expect(detailSource).toContain("MediaAssetAuthorityNotice");
    expect(detailSource).toContain("disabled={!canApproveMediaAsset(row)}");
  });
});
