// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminV2Request } = vi.hoisted(() => ({
  adminV2Request: vi.fn(),
}));

vi.mock("@/lib/admin-v2-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin-v2-api")>();
  return { ...actual, adminV2Request };
});
vi.mock("@/components/admin/i18n", () => ({
  adminDateLocale: () => undefined,
  useAdminI18n: () => ({
    locale: "en" as const,
    t: (
      value: string,
      values?: Readonly<Record<string, string | number>>,
    ) => Object.entries(values ?? {}).reduce(
      (text, [key, replacement]) =>
        text.replaceAll(`{${key}}`, String(replacement)),
      value,
    ),
  }),
}));

import { characterWorkspaceDetail } from "./character-workspace-fixture";
import { CharacterVoicePanel } from "./CharacterVoicePanel";

async function runCommittedMutation<T>(input: {
  commit: () => Promise<T>;
  afterRefresh?: () => void;
}) {
  const result = await input.commit();
  input.afterRefresh?.();
  return { result, refreshed: true };
}

/**
 * SPEC: journal 的幂等键存储替身 —— 同一个业务签名给同一个键，写入落地后释放。
 */
function createIdempotencyKeys() {
  const keys = new Map<string, string>();
  let sequence = 0;
  return {
    take: (signature: string) =>
      keys.get(signature) ??
      (keys.set(signature, `idem-${++sequence}`), keys.get(signature)!),
    release: (signature: string) => {
      keys.delete(signature);
    },
  };
}

let idempotencyKeys = createIdempotencyKeys();

const candidateProfile = {
  id: "voice-candidate-1",
  version: 3,
  provider: "fish_audio",
  providerVoiceId: "fish-candidate-1",
  model: "s2-pro",
  language: "en",
  delivery: {
    preset: "sensual",
    intensity: 0.6,
    speed: 1,
    temperature: 0.7,
    topP: 0.7,
    topK: 40,
    repetitionPenalty: 1.1,
  },
  status: "candidate",
  reference: {
    assetId: "voice-reference-1",
    filename: "mira-reference.wav",
    contentType: "audio/wav",
    sizeBytes: 1_048_576,
    transcript: "Come a little closer.",
  },
  preview: {
    assetId: "voice-preview-1",
    url: "/voice-candidate-1.mp3",
    durationMs: 4_000,
  },
  sampleText: "Come a little closer.",
  createdById: "actor-1",
  createdAt: "2026-07-30T12:00:00.000Z",
  archivedAt: null,
} as const;

const activeProfile = {
  ...candidateProfile,
  id: "voice-active-1",
  version: 2,
  status: "active",
  preview: { ...candidateProfile.preview, url: "/voice-active-1.mp3" },
} as const;

function withCandidate() {
  return characterWorkspaceDetail({
    character: { id: "character-voice-1", name: "Mira" },
    voice: {
      currentVoiceId: "fish-active-1",
      authoritySource: "character_clone",
      activeProfile,
      candidateProfile,
      history: [activeProfile, candidateProfile],
      systemDefaults: {
        catalog: [
          {
            id: "fish-female-default",
            label: "Warm female",
            presentation: "female",
            description: "Default female voice",
          },
        ],
      },
    },
  });
}

async function typeInto(selector: string, value: string) {
  const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    selector,
  );
  if (!element) throw new Error(`No field matched ${selector}`);
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("CharacterVoicePanel Fish Audio controls", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    adminV2Request.mockReset();
    idempotencyKeys = createIdempotencyKeys();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function render(
    data = withCandidate(),
    permissions: {
      canWrite?: boolean;
      canActivate?: boolean;
      canManageDefaults?: boolean;
    } = {},
  ) {
    await act(async () => root.render(
      <CharacterVoicePanel
        canActivate={permissions.canActivate ?? true}
        canManageDefaults={permissions.canManageDefaults ?? true}
        canWrite={permissions.canWrite ?? true}
        data={data}
        releaseIdempotencyKey={idempotencyKeys.release}
        runCommittedMutation={runCommittedMutation}
        takeIdempotencyKey={idempotencyKeys.take}
      />,
    ));
  }

  function button(label: string) {
    return [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.includes(label),
    );
  }

  it("sends the authored delivery settings with the voice clone reference", async () => {
    adminV2Request.mockResolvedValue({
      profile: candidateProfile,
      replayed: false,
    });
    await render();

    const file = new File(["reference-audio"], "mira-reference.wav", {
      type: "audio/wav",
    });
    const audioInput = container.querySelector<HTMLInputElement>(
      "#character-voice-reference",
    );
    Object.defineProperty(audioInput, "files", {
      configurable: true,
      value: [file],
    });
    await act(async () => {
      audioInput?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await typeInto(
      "#character-voice-reference-transcript",
      "Come a little closer.",
    );
    await typeInto(
      "#character-voice-change-reason",
      "Recorded a warmer reference take",
    );

    const form = container.querySelector<HTMLFormElement>(
      "#voice-candidate-builder",
    );
    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(adminV2Request).toHaveBeenCalledTimes(1);
    const body = adminV2Request.mock.calls[0]?.[1]?.form as FormData;
    // SPEC: 声音身份（参考音频 + 逐字稿）与表演方向（delivery）是两件事，一次提交都要带上。
    expect(body.get("audio")).toBe(file);
    expect(body.get("referenceText")).toBe("Come a little closer.");
    expect(JSON.parse(String(body.get("delivery")))).toMatchObject({
      preset: "sensual",
      repetitionPenalty: expect.any(Number),
    });
  });

  it("makes Fish Audio the visible runtime and exposes every performance control", async () => {
    await render();
    expect(container.textContent).toContain("Fish Audio S2 Pro");
    expect(container.textContent).toContain("Attraction intensity");
    expect(container.textContent).toContain("Speaking pace");
    expect(container.textContent).toContain("Advanced Fish sampling");
    expect(container.textContent).not.toContain("Pocket TTS");
  });

  it("names the exact authority it expects when activating a reviewed candidate", async () => {
    adminV2Request.mockResolvedValue({
      profile: { ...candidateProfile, status: "active" },
      replayed: false,
    });
    await render();

    // SPEC: 建候选不改 Character.voiceId——这句话必须写在运营看得到的地方。
    expect(container.textContent).toContain(
      "Creating a candidate never changes Character.voiceId",
    );
    const activate = button("Activate reviewed voice");
    expect(activate?.disabled).toBe(true);
    await typeInto(
      "#character-voice-activation-reason",
      "Reviewed the candidate preview",
    );
    expect(button("Activate reviewed voice")?.disabled).toBe(false);
    await act(async () => button("Activate reviewed voice")?.click());

    expect(adminV2Request).toHaveBeenCalledTimes(1);
    const [path, options] = adminV2Request.mock.calls[0] ?? [];
    expect(path).toContain(
      "/voice-clones/voice-candidate-1/activate",
    );
    // SPEC: 激活必须声明它以为的当前权威；服务端据此拒绝基于旧投影的激活。
    expect(options?.body).toMatchObject({
      reason: "Reviewed the candidate preview",
      expectedActiveProfileId: "voice-active-1",
      expectedCurrentVoiceId: "fish-active-1",
    });
  });

  // SPEC: 重试一次失败的激活必须复用同一个幂等键。
  // INTENT: 这四处写入原本每次点击现开一个 UUID —— 第一次请求其实已经到达服务端、只是响应
  //         在网络上丢了的话，运营再点一次就是第二次真实激活。
  it("replays a failed activation under the same idempotency key", async () => {
    adminV2Request.mockRejectedValue(new Error("network down"));
    await render();
    await typeInto(
      "#character-voice-activation-reason",
      "Reviewed the candidate preview",
    );

    await act(async () => button("Activate reviewed voice")?.click());
    await act(async () => button("Activate reviewed voice")?.click());

    expect(adminV2Request).toHaveBeenCalledTimes(2);
    const keys = adminV2Request.mock.calls.map(
      ([, options]) => options?.idempotencyKey,
    );
    expect(keys[0]).toBeDefined();
    expect(keys[1]).toBe(keys[0]);
  });

  it("blocks activation while the Fish Audio runtime is not ready", async () => {
    await render(
      characterWorkspaceDetail({
        character: { id: "character-voice-1", name: "Mira" },
        voice: {
          runtimeStatus: "unavailable",
          cloningAvailable: false,
          currentVoiceId: "fish-active-1",
          activeProfile,
          candidateProfile,
        },
      }),
    );
    await typeInto(
      "#character-voice-activation-reason",
      "Reviewed the candidate preview",
    );
    expect(button("Activate reviewed voice")?.disabled).toBe(true);
    expect(container.textContent).toContain(
      "Fish Audio must be the active voice provider",
    );
    expect(adminV2Request).not.toHaveBeenCalled();
  });

  it("keeps one candidate task visible and folds secondary configuration away", async () => {
    await render();
    expect(container.querySelector('[data-testid="voice-control-room"]'))
      .not.toBeNull();
    expect(
      container.querySelector('[data-testid="voice-candidate-primary-action"]'),
    ).not.toBeNull();
    expect(container.querySelector("#voice-candidate-builder")).not.toBeNull();
    expect(container.querySelector('[data-testid="live-voice-configuration"]'))
      .not.toBeNull();
    expect(container.querySelector('[data-testid="system-voice-defaults"]'))
      .not.toBeNull();
    const systemDefaultsSummary = container.querySelector(
      '[data-testid="system-voice-defaults"] > summary',
    );
    // SPEC: 窄屏时操作入口独占一行，不能把说明文案压成逐词换行。
    expect(systemDefaultsSummary?.className).toContain("flex-col");
    expect(systemDefaultsSummary?.className).toContain("sm:flex-row");
    expect(container.textContent).toContain("Live voice");
    expect(container.textContent).toContain("Current voice and runtime");
    expect(container.textContent).toContain("System voice defaults");
    // SPEC: 表演方向属于次要配置，收进折叠区，但必须还在。
    expect(container.textContent).toContain("Voice style and advanced settings");
    expect(container.textContent).toContain("System performance direction");
    // SPEC: 次要配置必须默认折叠——一屏只留一个候选任务。
    expect([...container.querySelectorAll("details")].length)
      .toBeGreaterThan(0);
    expect([...container.querySelectorAll("details")]
      .every((element) => element.open === false)).toBe(true);
    expect(
      container.querySelector('audio[aria-label="Active cloned voice preview"]')
        ?.getAttribute("src"),
    ).toBe("/voice-active-1.mp3");
  });

  it("uses a localized file picker instead of browser-native English copy", async () => {
    await render();
    const audioInput = container.querySelector<HTMLInputElement>(
      "#character-voice-reference",
    );
    // SPEC: 原生 file input 只留给辅助技术，可见的按钮与文件名都必须走 t()。
    expect(audioInput?.className).toContain("sr-only");
    expect(
      container.querySelector<HTMLLabelElement>(
        'label[for="character-voice-reference"]',
      )?.textContent,
    ).toContain("Choose audio");
    expect(container.textContent).toContain("No audio selected");

    Object.defineProperty(audioInput, "files", {
      configurable: true,
      value: [new File(["audio"], "mira-reference.wav", { type: "audio/wav" })],
    });
    await act(async () => {
      audioInput?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.textContent).toContain("mira-reference.wav");
    expect(container.textContent).not.toContain("No audio selected");
  });
});
