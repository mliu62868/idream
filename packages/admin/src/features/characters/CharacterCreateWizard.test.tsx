import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  CharacterCreateWizard,
  characterCreateStepRequirements,
  characterCreateSteps,
  isCharacterCreateStepComplete,
} from "./CharacterCreateWizard";
import { hasAdminZh } from "@/components/admin/i18n";
import type { AdminPermissionKey } from "@idream/shared/admin";
import { CharacterWorkspace } from "./CharacterWorkspace";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

describe("Character create wizard", () => {
  it("opens on the character itself, not on a launch brief", () => {
    const html = renderToStaticMarkup(
      createElement(CharacterCreateWizard, { canCreate: true }),
    );
    expect(html).toContain('data-testid="character-create-wizard"');
    expect(html).toContain("Persona");
    expect(html).toContain("Visual direction");
    expect(html).toContain("Review");
    expect(html).toContain("Private draft setup");
    expect(html).toContain("No Character has been created yet.");
    expect(html).toContain("Continue to visual direction");
    expect(html).toContain('aria-current="step"');
    expect(html).toContain(
      'aria-describedby="character-create-step-requirements"',
    );
    expect(html).toContain('id="character-create-step-requirements"');
    expect(html).toContain('max="120"');
    // 第一步就是取名，而不是先写受众/假设/成功标准这类上线简报。
    expect(html).toContain('placeholder="Mara"');
    expect(html).not.toContain("Positioning");
    expect(html).not.toContain("Commercial intent");
    expect(html).not.toContain(
      'placeholder="Adults winding down after high-pressure work"',
    );
    expect(html).not.toContain('value="Untitled companion"');
    // 首次客户端恢复完成后按钮可点击并显示字段级纠错；SSR 的 checking 态仍应锁住。
  });

  it("marks only the fields the contract actually enforces as required", () => {
    const html = renderToStaticMarkup(
      createElement(CharacterCreateWizard, { canCreate: true }),
    );
    expect(html).toContain("Additional details · Markdown (optional)");
    expect(html).not.toContain("Backstory (optional)");
    expect(html).not.toContain("Example dialogue (optional, one per line)");
    const promise =
      /Character promise[\s\S]{0,700}?<\/textarea>/.exec(html)?.[0] ?? "";
    expect(promise).toContain('required=""');
    const opening =
      /First message[\s\S]{0,700}?<\/textarea>/.exec(html)?.[0] ?? "";
    expect(opening).toContain('required=""');
  });

  it("keeps the wizard's dynamic step labels translated", () => {
    // SPEC: 步骤名与步骤要求走 t(变量)，i18n 完整性审计只认 t("字面量")，扫不到它们。
    // INTENT: 这两组文案漏翻不会有任何测试报警，中文运营会在向导里看到英文步骤名。
    for (const key of [
      ...characterCreateSteps,
      ...characterCreateStepRequirements,
    ]) {
      expect(hasAdminZh(key), `missing zh for ${JSON.stringify(key)}`).toBe(
        true,
      );
    }
  });

  it("requires meaningful operator input at each step instead of accepting instructional copy", () => {
    const blank = {
      persona: {
        name: "",
        age: 18,
        gender: "female" as const,
        characterPromise: "",
        detailsMarkdown: "",
        firstMessage: "",
      },
      visualDirection: {
        identityAnchor: "",
        stableTraits: [],
        style: "realistic" as const,
        referenceDirection: "",
      },
    };
    const persona = {
      ...blank.persona,
      name: "Mara",
      characterPromise: "A precise, warm place to put the day down",
      detailsMarkdown: "Observant, measured, gently challenging",
      firstMessage: "You made it. What should we make space for?",
    };
    const visualDirection = {
      identityAnchor: "Composed late-night radio host",
      stableTraits: ["dark wavy hair"],
      style: "realistic" as const,
      referenceDirection: "Low-key tungsten portraiture",
    };

    expect(isCharacterCreateStepComplete(blank, 0)).toBe(false);
    expect(isCharacterCreateStepComplete({ ...blank, persona }, 0)).toBe(true);
    // 扩展 Markdown 可完全为空，基本信息和开场白才是创建门槛。
    expect(
      isCharacterCreateStepComplete(
        { ...blank, persona: { ...persona, detailsMarkdown: "" } },
        0,
      ),
    ).toBe(true);
    expect(
      isCharacterCreateStepComplete(
        { ...blank, persona: { ...persona, firstMessage: "" } },
        0,
      ),
    ).toBe(false);
    expect(isCharacterCreateStepComplete({ ...blank, persona }, 1)).toBe(false);
    expect(
      isCharacterCreateStepComplete({ ...blank, persona, visualDirection }, 1),
    ).toBe(true);
    expect(isCharacterCreateStepComplete(blank, 2)).toBe(false);
  });

  it("creates a Character without project-management metadata", () => {
    const noBrief = {
      persona: {
        name: "Mara",
        age: 28,
        gender: "female" as const,
        characterPromise: "A precise, warm place to put the day down",
        detailsMarkdown: "",
        firstMessage: "You made it. What should we make space for?",
      },
      visualDirection: {
        identityAnchor: "Composed late-night radio host",
        stableTraits: ["dark wavy hair"],
        style: "realistic" as const,
        referenceDirection: "Low-key tungsten portraiture",
      },
    };

    expect(isCharacterCreateStepComplete(noBrief, 0)).toBe(true);
    expect(isCharacterCreateStepComplete(noBrief, 1)).toBe(true);
    expect(isCharacterCreateStepComplete(noBrief, 2)).toBe(true);
  });

  it("lets an old instructional draft resume but blocks it from final creation", () => {
    const instructional = {
      persona: {
        name: "Untitled companion",
        age: 18,
        gender: "female" as const,
        characterPromise: "A specific, dependable companionship promise",
        detailsMarkdown:
          "Warm, observant, and consistent. Natural, concise, and emotionally present.",
        firstMessage: "I'm here. Where should we begin?",
      },
      visualDirection: {
        identityAnchor: "A recognizable adult companion identity",
        stableTraits: ["consistent face", "recognizable silhouette"],
        style: "realistic" as const,
        referenceDirection:
          "Describe lighting, framing, wardrobe, and reference direction.",
      },
    };

    expect(isCharacterCreateStepComplete(instructional, 0)).toBe(true);
    expect(isCharacterCreateStepComplete(instructional, 2)).toBe(false);
  });

  it("fails closed without Character Project write permission", () => {
    const html = renderToStaticMarkup(
      createElement(CharacterCreateWizard, { canCreate: false }),
    );
    expect(html).toContain("No permission");
    expect(html).toContain("character.project.write");
    expect(html).not.toContain("Continue to visual direction");
  });

  it("dispatches the canonical new subview to the wizard instead of Portfolio", () => {
    const html = renderToStaticMarkup(
      createElement(CharacterWorkspace, {
        actorId: "test-admin",
        view: { kind: "new" },
        permissions: new Set<AdminPermissionKey>(["character.project.write"]),
      }),
    );
    expect(html).toContain('data-testid="character-create-wizard"');
    expect(html).not.toContain("Portfolio &amp; Projects");
  });
});
