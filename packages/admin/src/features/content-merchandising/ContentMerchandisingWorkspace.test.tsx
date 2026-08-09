import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminV2RequestError } from "@/components/admin/api";
import {
  ContentMerchandisingWorkspace,
  type FeaturedItem,
  FeaturedWriteResultNotice,
  featuredTableRow,
  featuredVersionConflictFromError,
} from "./ContentMerchandisingWorkspace";

describe("Content merchandising permissions", () => {
  it("renders independent authority freshness and read-only state", () => {
    const html = renderToStaticMarkup(
      <ContentMerchandisingWorkspace canWrite={false} />,
    );
    expect(html).toContain("Characters: refreshing");
    expect(html).toContain("Featured: refreshing");
    expect(html).toContain("content.takedown.write is not granted");
  });

  it("labels a configured but runtime-ineligible item as not live", () => {
    const html = renderFeaturedRow({
      id: "character-paused",
      name: "Paused Character",
      visibility: "public",
      status: "approved",
      configuredPosition: 0,
      configured: true,
      effective: false,
      blockers: [{
        code: "serving_not_live",
        message: "Character Serving is not live.",
        repairDeepLink: "/admin/characters/character-paused?tab=release",
      }],
    });

    expect(html).toContain("Configured · not live");
    expect(html).not.toContain(">Live featured<");
    expect(html).toContain("serving not live");
    expect(html).toContain("Character Serving is not live.");
    expect(html).toContain(
      'href="/admin/characters/character-paused?tab=release"',
    );
    expect(html).toContain("Resolve blocker");
  });

  it("labels only an effective item as live featured", () => {
    const html = renderFeaturedRow({
      id: "character-live",
      name: "Live Character",
      visibility: "public",
      status: "approved",
      configuredPosition: 1,
      configured: true,
      effective: true,
      blockers: [],
    });

    expect(html).toContain("Live featured");
    expect(html).not.toContain("Configured · not live");
    expect(html).toContain(">None<");
  });

  it("shows the exact saved, effective, and skipped-invalid write result", () => {
    const html = renderToStaticMarkup(
      <FeaturedWriteResultNotice
        result={{
          characterIds: ["character-paused"],
          configuredCharacterIds: ["character-paused"],
          effectiveCharacterIds: [],
          settingVersion: 4,
          settingDiagnostics: [],
          skipped: ["character-missing"],
          invalid: [{
            id: "character-missing",
            reason: "character_not_found_or_not_configurable",
          }],
        }}
      />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Featured configuration saved");
    expect(html).toContain("1 Configured");
    expect(html).toContain("0 Live featured");
    expect(html).toContain("1 Configured · not live");
    expect(html).toContain("Skipped invalid character IDs");
    expect(html).toContain("character-missing");
    expect(html).toContain(
      "These characters were not found or cannot be configured, so they were not saved.",
    );
  });

  it("recognizes only the canonical Featured version conflict details", () => {
    expect(
      featuredVersionConflictFromError(
        new AdminV2RequestError(
          "Featured configuration changed before this save was applied",
          409,
          "conflict",
          {
            reason: "featured_setting_version_conflict",
            settingVersion: 7,
            configuredCharacterIds: ["character-current"],
          },
        ),
      ),
    ).toEqual({
      settingVersion: 7,
      configuredCharacterIds: ["character-current"],
    });
    expect(
      featuredVersionConflictFromError(
        new AdminV2RequestError("Other conflict", 409, "conflict", {}),
      ),
    ).toBeNull();
  });
});

function renderFeaturedRow(item: FeaturedItem) {
  const row = featuredTableRow(item);
  return renderToStaticMarkup(
    <table>
      <tbody>
        <tr>
          {row.cells.map((value, index) => (
            <td key={index}>{value}</td>
          ))}
        </tr>
      </tbody>
    </table>,
  );
}
