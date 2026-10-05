// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminI18nProvider } from "@/components/admin/i18n";
import { InvariantsWorkspace } from "./InvariantsWorkspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const check = {
  key: "serving_validation_stale", description: "Current Releases require an exact public qualification",
  status: "failed", violationCount: 2, sampleIds: ["release/exact", "rollback:unmapped"], evidence: "Release qualification evidence",
};
const report = {
  asOf: "2026-10-04T12:00:00.000Z", qualityState: "invalid", decisionUse: "blocked", totalViolations: 2,
  unavailableChecks: 0, checks: [check],
};

describe("Invariant operator repair targets", () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function mount() {
    await act(async () => { root.render(<AdminI18nProvider locale="zh"><InvariantsWorkspace canRead /></AdminI18nProvider>); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
  }

  it("keeps Release IDs and links only matched authority targets to the Character Release workspace", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: {
      ...report, checks: [{ ...check, sampleTargets: [
        { sampleId: "release/exact", characterId: "character/real" },
        { sampleId: "not-a-sample", characterId: "character-unrelated" },
      ] }],
    } })));
    await mount();
    const link = container.querySelector<HTMLAnchorElement>('a[href="/admin/characters/character%2Freal?tab=release"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toBe("去发布");
    expect(container.querySelector('code[title="release/exact"]')).not.toBeNull();
    expect(container.querySelector('code[title="rollback:unmapped"]')).not.toBeNull();
    expect(container.querySelectorAll('a[href^="/admin/characters/"]')).toHaveLength(1);
  });

  it("accepts reports without target metadata and never guesses a Character from an opaque sample", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: report })));
    await mount();
    expect(container.querySelector('code[title="release/exact"]')).not.toBeNull();
    expect(container.querySelector('code[title="rollback:unmapped"]')).not.toBeNull();
    expect(container.querySelectorAll('a[href^="/admin/characters/"]')).toHaveLength(0);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
