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
      candidateRuntimeStatus: "ready",
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

describe("CharacterVoicePanel voice identity controls", () => {
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
      canPreview?: boolean;
    } = {},
  ) {
    await act(async () => root.render(
      <CharacterVoicePanel
        canActivate={permissions.canActivate ?? true}
        canManageDefaults={permissions.canManageDefaults ?? true}
        canPreview={permissions.canPreview ?? true}
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

  it("shows the official Pocket CPU runtime without Fish-only delivery controls", async () => {
    const pocketCandidate = {
      ...candidateProfile,
      provider: "pocket_tts" as const,
      providerVoiceId: "pocket-candidate-1",
      model: "pocket-tts",
    };
    await render(
      characterWorkspaceDetail({
        character: { id: "character-pocket-1", name: "Mira" },
        voice: {
          provider: "pocket_tts",
          runtimeStatus: "ready",
          runtimeEngine: "pocket_tts",
          runtimeVersion: "3.0.2",
          runtimeLanguage: "english",
          catalogVoiceIds: ["alba", "anna"],
          presetRuntime: { provider: "pocket_tts", runtimeStatus: "ready", catalogVoiceIds: ["alba", "anna"] },
          candidateRuntimeStatus: "ready",
          cloningAvailable: false,
          currentVoiceId: null,
          effectiveVoiceId: "alba",
          authoritySource: "system_default",
          systemDefaults: {
            provider: "pocket_tts",
            defaultVoiceId: "alba",
            genderVoiceIds: {
              female: "alba",
              male: "alba",
              trans: "alba",
            },
            catalog: [
              {
                id: "alba",
                label: "Alba",
                presentation: "unspecified",
                description: "Official English Pocket TTS voice",
              },
              {
                id: "anna",
                label: "Anna",
                presentation: "unspecified",
                description: "Official English Pocket TTS voice",
              },
            ],
          },
          activeProfile: null,
          candidateProfile: pocketCandidate,
          history: [pocketCandidate],
        },
      }),
    );

    expect(container.textContent).toContain("Pocket TTS 3.0.2");
    expect(container.textContent).toContain(
      "Choose an official English Pocket voice",
    );
    expect(container.textContent).toContain("2 official English voices available");
    expect(container.textContent).toContain(
      "Pocket TTS uses each official voice's native English delivery",
    );
    expect(container.querySelector('[data-testid="voice-preset-builder"]'))
      .not.toBeNull();
    expect(container.querySelector("#voice-candidate-builder")).toBeNull();
    expect(container.querySelector("#character-performance-direction")).toBeNull();
  });

  it("creates a role-specific candidate from the selected Pocket catalog voice", async () => {
    adminV2Request.mockResolvedValue({
      profile: {
        ...candidateProfile,
        provider: "pocket_tts",
        providerVoiceId: "idream-pocket-anna-1",
        model: "pocket-tts",
      },
      replacedCandidateProfileId: null,
      replayed: false,
    });
    await render(
      characterWorkspaceDetail({
        character: { id: "character-pocket-2", name: "Mira" },
        voice: {
          provider: "pocket_tts",
          runtimeStatus: "ready",
          runtimeEngine: "pocket_tts",
          runtimeVersion: "3.0.2",
          runtimeLanguage: "english",
          catalogVoiceIds: ["alba", "anna"],
          presetRuntime: { provider: "pocket_tts", runtimeStatus: "ready", catalogVoiceIds: ["alba", "anna"] },
          candidateRuntimeStatus: "ready",
          cloningAvailable: false,
          currentVoiceId: null,
          authoritySource: "system_default",
          activeProfile: null,
          candidateProfile: null,
          history: [],
        },
      }),
    );
    const select = container.querySelector<HTMLSelectElement>(
      "#character-pocket-preset-voice",
    );
    await act(async () => {
      if (!select) throw new Error("Pocket preset selector is missing");
      select.value = "anna";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await typeInto(
      "#character-pocket-preset-reason",
      "Assign a distinct fast voice to Mira",
    );
    await act(async () => {
      container
        .querySelector<HTMLFormElement>('[data-testid="voice-preset-builder"]')
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(adminV2Request).toHaveBeenCalledTimes(1);
    const [path, options] = adminV2Request.mock.calls[0] ?? [];
    expect(path).toBe(
      "/api/v2/admin/characters/character-pocket-2/voice-presets",
    );
    expect(options).toMatchObject({
      method: "POST",
      idempotencyKey: expect.any(String),
      body: {
        presetVoiceId: "anna",
        sampleText: expect.stringContaining("Mira"),
        reason: "Assign a distinct fast voice to Mira",
      },
    });
  });

  it("names the exact authority it expects when activating a reviewed candidate", async () => {
    adminV2Request.mockResolvedValue({
      profile: { ...candidateProfile, status: "active" },
      replayed: false,
    });
    await render();

    // SPEC: 运营文案必须说明候选不改当前音色，避免暴露内部字段名。
    expect(container.textContent).toContain(
      "Creating a candidate keeps the current voice unchanged.",
    );
    const activate = button("Activate voice");
    expect(activate?.disabled).toBe(true);
    await typeInto(
      "#character-voice-activation-reason",
      "Reviewed the candidate preview",
    );
    expect(button("Activate voice")?.disabled).toBe(false);
    await act(async () => button("Activate voice")?.click());

    expect(adminV2Request).toHaveBeenCalledTimes(1);
    const [path, options] = adminV2Request.mock.calls[0] ?? [];
    expect(path).toContain(
      "/voice-profiles/voice-candidate-1/activate",
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

    await act(async () => button("Activate voice")?.click());
    await act(async () => button("Activate voice")?.click());

    expect(adminV2Request).toHaveBeenCalledTimes(2);
    const keys = adminV2Request.mock.calls.map(
      ([, options]) => options?.idempotencyKey,
    );
    expect(keys[0]).toBeDefined();
    expect(keys[1]).toBe(keys[0]);
  });

  it("blocks activation while the candidate provider runtime is not ready", async () => {
    await render(
      characterWorkspaceDetail({
        character: { id: "character-voice-1", name: "Mira" },
        voice: {
          runtimeStatus: "unavailable",
          candidateRuntimeStatus: "unavailable",
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
    expect(button("Activate voice")?.disabled).toBe(true);
    expect(container.textContent).toContain(
      "The candidate provider must be ready",
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
      container.querySelector('audio[aria-label="Active character voice preview"]')
        ?.getAttribute("src"),
    ).toBe("/voice-active-1.mp3");
  });

  // SPEC: 系统语音默认值是从单个角色页面能改到全站的唯一一处写操作。
  // INTENT: 原先只有一个 reason 输入框加一个「保存」按钮，界面上没有任何一句说明这是全局的。
  it("states the platform-wide blast radius before saving system voice defaults", async () => {
    adminV2Request.mockResolvedValue({ replayed: false });
    await render();

    const save = button("Save system defaults");
    expect(save).toBeTruthy();
    await act(async () => save?.click());
    expect(adminV2Request).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "It changes new speech for every character that has no voice override",
    );

    const reason = document.body.querySelector<HTMLInputElement>(
      'input[aria-label="System default change reason"]',
    );
    expect(reason).toBeTruthy();
    await act(async () => {
      setInputValue(reason!, "Rotate the shared default after provider change");
    });
    const submit = [...document.body.querySelectorAll("button")].find(
      (candidate) =>
        candidate.textContent?.includes("Save system defaults") &&
        candidate !== save,
    );
    await act(async () => submit?.click());
    expect(adminV2Request).toHaveBeenCalledWith(
      "/api/v2/admin/voice-defaults",
      expect.objectContaining({
        body: expect.objectContaining({
          provider: "fish_audio",
          reason: "Rotate the shared default after provider change",
        }),
      }),
    );
  });

  it("preserves gender mappings when editing only the global fallback", async () => {
    const data = withCandidate();
    data.voice.systemDefaults.catalog = ["fish-female-default", "another"].map((id) => ({
      id, label: id, presentation: "unspecified", description: "Voice",
    }));
    await render(data);
    const select = container.querySelector<HTMLSelectElement>("#system-voice-default-global")!;
    await act(async () => {
      select.value = "another";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      button("Save system defaults")?.click();
    });
    await typeInto('input[aria-label="System default change reason"]', "Change only the fallback");
    adminV2Request.mockResolvedValue({ replayed: false });
    await act(async () => {
      document.querySelector<HTMLDivElement>('[role="dialog"]')?.querySelector<HTMLButtonElement>('button:last-child')?.click();
    });
    expect(adminV2Request).toHaveBeenCalledWith("/api/v2/admin/voice-defaults", expect.objectContaining({
      body: expect.objectContaining({ defaultVoiceId: "another", genderVoiceIds: data.voice.systemDefaults.genderVoiceIds }),
    }));
  });

  it("previews the live default with saved delivery even while the draft is edited", async () => {
    await render(characterWorkspaceDetail());
    const system = container.querySelector('[data-testid="system-voice-defaults"]')!;
    const natural = [...system.querySelectorAll("button")].find((item) => item.textContent?.includes("Natural"))!;
    await act(async () => natural.click());
    adminV2Request.mockResolvedValue({ contentType: "audio/wav", audioBase64: "AAAA" });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="voice-control-room"] button')?.click());
    expect(adminV2Request).toHaveBeenCalledWith("/api/v2/admin/voice-defaults/preview", expect.objectContaining({
      body: expect.objectContaining({ delivery: expect.objectContaining({ preset: "sensual" }) }),
    }));
    expect(container.querySelectorAll("audio[autoplay]")).toHaveLength(1);
  });

  it("keeps a failed system save dialog and its reason for an idempotent retry", async () => {
    await render();
    await act(async () => button("Save system defaults")?.click());
    await typeInto('input[aria-label="System default change reason"]', "Keep this retry reason");
    adminV2Request.mockRejectedValueOnce(new Error("Network interrupted"));
    const submit = () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((item) => item.textContent?.includes("Save system defaults"))!;
    await act(async () => submit().click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector<HTMLInputElement>('input[aria-label="System default change reason"]')?.value).toBe("Keep this retry reason");
    const firstKey = adminV2Request.mock.calls[0]?.[1].idempotencyKey;
    adminV2Request.mockResolvedValueOnce({ replayed: true });
    await act(async () => submit().click());
    expect(adminV2Request.mock.calls[1]?.[1].idempotencyKey).toBe(firstKey);
  });

  it("does not label Pocket speech with unused Fish performance controls", async () => {
    const data = characterWorkspaceDetail({ voice: { systemDefaults: { provider: "pocket_tts" }, effectiveVoiceId: "alba" } });
    await render(data);
    expect(container.querySelector('[data-testid="voice-control-room"]')?.textContent).not.toContain("Sensual");
    expect(container.querySelector('[data-testid="live-voice-configuration"]')?.textContent).not.toContain("Sensual");
  });

  it("offers official presets alongside Fish cloning and activates a Pocket candidate independently", async () => {
    const data = withCandidate();
    data.voice.presetRuntime = { provider: "pocket_tts", runtimeStatus: "ready", catalogVoiceIds: ["alba", "anna"] };
    data.voice.candidateProfile = { ...candidateProfile, provider: "pocket_tts" };
    data.voice.runtimeStatus = "unavailable";
    data.voice.cloningAvailable = false;
    data.voice.candidateRuntimeStatus = "ready";
    await render(data);
    expect(container.querySelector('[data-testid="voice-preset-builder"]')).not.toBeNull();
    expect(container.querySelector('#voice-candidate-builder')).not.toBeNull();
    expect(container.querySelector<HTMLSelectElement>('#character-pocket-preset-voice')?.disabled).toBe(false);
    await typeInto("#character-voice-activation-reason", "Listen to the official candidate");
    expect(button("Activate voice")?.disabled).toBe(false);
    expect(container.querySelector<HTMLTextAreaElement>("#character-pocket-preset-preview-script")?.value).toContain("Hello");
  });

  it("keeps system mapping fields read-only without generation config permission", async () => {
    await render(withCandidate(), { canManageDefaults: false });
    const fields = [...container.querySelectorAll<HTMLSelectElement>('[data-testid="system-voice-defaults"] select')];
    expect(fields).toHaveLength(4);
    expect(fields.every((field) => field.disabled)).toBe(true);
  });

  it("requires a new review when the candidate or live authority changes", async () => {
    await render();
    await typeInto("#character-voice-activation-reason", "Reviewed the original candidate");
    expect(button("Activate voice")?.disabled).toBe(false);
    const changed = withCandidate();
    changed.voice.candidateProfile = { ...candidateProfile, id: "replacement-candidate", version: 4 };
    await render(changed);
    expect(container.querySelector<HTMLInputElement>("#character-voice-activation-reason")?.value).toBe("");
    expect(button("Activate voice")?.disabled).toBe(true);

    await typeInto("#character-voice-activation-reason", "Reviewed the replacement candidate");
    await render({ ...changed, voice: { ...changed.voice, currentVoiceId: "new-live-pointer" } });
    expect(button("Activate voice")?.disabled).toBe(true);
    expect(adminV2Request).not.toHaveBeenCalled();
  });

  it("preserves an edited default draft on refresh and requires explicit reload", async () => {
    const data = withCandidate();
    data.voice.systemDefaults.catalog = ["fish-female-default", "another"].map((id) => ({
      id, label: id, presentation: "unspecified", description: "Voice",
    }));
    await render(data);
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>("#system-voice-default-global")!;
      select.value = "another";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await render({ ...data, voice: { ...data.voice, systemDefaults: { ...data.voice.systemDefaults, settingVersion: 9 } } });
    expect(container.querySelector<HTMLSelectElement>("#system-voice-default-global")?.value).toBe("another");
    expect(container.textContent).toContain("System defaults changed while you were editing.");
    expect(button("Save system defaults")?.disabled).toBe(true);
    await act(async () => button("Discard draft and load current defaults")?.click());
    expect(container.querySelector<HTMLSelectElement>("#system-voice-default-global")?.value).toBe("fish-female-default");
    expect(button("Save system defaults")?.disabled).toBe(false);
  });

  it("pins the confirmed mapping and retry key even when refreshed defaults arrive", async () => {
    const data = withCandidate();
    await render(data);
    await act(async () => button("Save system defaults")?.click());
    await typeInto('input[aria-label="System default change reason"]', "Keep the reviewed mapping");
    const submit = () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((item) => item.textContent?.includes("Save system defaults"))!;
    adminV2Request.mockRejectedValueOnce(new Error("Acknowledgement lost"));
    await act(async () => submit().click());
    const firstOptions = adminV2Request.mock.calls[0]?.[1];
    await render({ ...data, voice: { ...data.voice, systemDefaults: { ...data.voice.systemDefaults, settingVersion: 9, defaultVoiceId: "another" } } });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("System fallback identity");
    adminV2Request.mockResolvedValueOnce({ replayed: true });
    await act(async () => submit().click());
    expect(adminV2Request.mock.calls[1]?.[1]).toEqual(firstOptions);
  });

  it("invalidates a reset review when the default it would inherit changes", async () => {
    await render();
    const resetInput = () => container.querySelector<HTMLInputElement>('[data-testid="live-voice-configuration"] input')!;
    await act(async () => setInputValue(resetInput(), "Restore the reviewed default"));
    expect(resetInput().value).toBe("Restore the reviewed default");
    const data = withCandidate();
    data.voice.systemDefaults.settingVersion += 1;
    await render(data);
    expect(resetInput().value).toBe("");
    expect(adminV2Request).not.toHaveBeenCalled();
  });

  it("keeps a confirmation open with an error when write permission is revoked", async () => {
    await render();
    await act(async () => button("Save system defaults")?.click());
    await typeInto('input[aria-label="System default change reason"]', "Save the reviewed default");
    await render(withCandidate(), { canManageDefaults: false });
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((item) => item.textContent?.includes("Save system defaults"))?.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain("You no longer have permission");
    expect(adminV2Request).not.toHaveBeenCalled();
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

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}
