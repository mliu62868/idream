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
import { createCharacterCommandJournal } from "./character-command-journal";

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
  const profiles = new Map<string, string>();
  let sequence = 0;
  return {
    take: (signature: string) =>
      keys.get(signature) ??
      (keys.set(signature, `idem-${++sequence}`), keys.get(signature)!),
    release: (signature: string) => {
      keys.delete(signature);
      profiles.delete(signature);
    },
    bindProfile: (signature: string, key: string, profileId: string) => {
      if (keys.get(signature) === key) profiles.set(signature, profileId);
    },
    releaseProfile: (profileId: string) => {
      for (const [signature, target] of profiles) {
        if (target !== profileId) continue;
        keys.delete(signature);
        profiles.delete(signature);
      }
    },
  };
}

let idempotencyKeys = createIdempotencyKeys();

const candidateProfile = {
  id: "voice-candidate-1",
  version: 3,
  provider: "fish_audio",
  providerVoiceId: "fish-candidate-1",
  presetVoiceId: null,
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

const pocketCatalog = ["vera", "anna"].map((id) => ({
  id,
  label: id.charAt(0).toUpperCase() + id.slice(1),
  presentation: "female" as const,
  description: "Official English Pocket TTS voice",
}));

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

// Pocket owns system speech and the official catalog; Fish owns cloning.
function pocketWorkspace() {
  return characterWorkspaceDetail({
    character: { id: "character-pocket-1", name: "Mira" },
    voice: {
      provider: "fish_audio",
      cloningAvailable: true,
      runtimeStatus: "ready",
      runtimeEngine: "mlx_audio",
      runtimeModel: "ming-3.0-tts-0.5b-8bit",
      runtimeVersion: "0.4.3",
      presetRuntime: { provider: "pocket_tts", runtimeStatus: "ready", catalogVoiceIds: ["vera", "anna"] },
      candidateRuntimeStatus: null,
      currentVoiceId: null,
      effectiveVoiceId: "vera",
      authoritySource: "system_default",
      systemDefaults: {
        provider: "pocket_tts",
        defaultVoiceId: "vera",
        genderVoiceIds: { female: "vera", male: "vera", trans: "vera" },
        catalog: pocketCatalog,
      },
      activeProfile: null,
      candidateProfile: null,
      history: [],
    },
  });
}

function mingWorkspace() {
  const data = pocketWorkspace();
  const voiceId = "system-anna-reference-v1";
  data.voice.effectiveVoiceId = voiceId;
  data.voice.systemDefaults = {
    ...data.voice.systemDefaults,
    provider: "fish_audio",
    defaultVoiceId: voiceId,
    genderVoiceIds: { female: voiceId, male: voiceId, trans: voiceId },
    catalog: [{ id: voiceId, label: "System Anna Reference V1", presentation: "female", description: "Configured Ming voice" }],
  };
  return data;
}

const createdPocketProfile = {
  ...candidateProfile,
  id: "voice-pocket-anna",
  provider: "pocket_tts",
  providerVoiceId: "idream-pocket-anna",
  presetVoiceId: "anna",
  model: "pocket-tts",
} as const;

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

function dialog() {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

function dialogButton(label: string) {
  return [...(dialog()?.querySelectorAll("button") ?? [])].find(
    (candidate) => candidate.textContent?.includes(label),
  );
}

async function confirmDialog(submitLabel: string) {
  // SPEC: voice writes never ask for a reason; the dialog is a plain confirmation.
  expect(dialog()?.querySelector("input")).toBeNull();
  await act(async () => dialogButton(submitLabel)?.click());
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
    commitMutation = runCommittedMutation,
  ) {
    await act(async () => root.render(
      <CharacterVoicePanel
        canActivate={permissions.canActivate ?? true}
        canManageDefaults={permissions.canManageDefaults ?? true}
        canPreview={permissions.canPreview ?? true}
        canWrite={permissions.canWrite ?? true}
        data={data}
        releaseIdempotencyKey={idempotencyKeys.release}
        bindVoiceProfile={idempotencyKeys.bindProfile}
        releaseVoiceProfileKeys={idempotencyKeys.releaseProfile}
        runCommittedMutation={commitMutation}
        takeIdempotencyKey={idempotencyKeys.take}
      />,
    ));
  }

  function button(label: string) {
    return [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.includes(label),
    );
  }

  function modelRadio(id: "voice-model-official" | "voice-model-clone") {
    return container.querySelector<HTMLInputElement>(`#${id}`);
  }

  async function chooseModel(id: "voice-model-official" | "voice-model-clone") {
    await act(async () => modelRadio(id)?.click());
  }

  async function chooseOfficialVoice(voiceId: string) {
    await act(async () => {
      container.querySelector<HTMLInputElement>(`#character-official-voice-${voiceId}`)?.click();
    });
  }

  // SPEC: 运营进来第一眼要看到「现在是什么声音、哪个模型、从哪来」，而不是表单。
  it("leads with the live voice, its model and where it comes from", async () => {
    await render(pocketWorkspace());
    const room = container.querySelector('[data-testid="voice-control-room"]');
    expect(room?.textContent).toContain("Current voice");
    expect(room?.textContent).toContain("Vera");
    expect(room?.textContent).toContain("Pocket TTS");
    expect(room?.textContent).toContain("System inheritance");
    // SPEC: 继承默认时没有可恢复的对象。
    expect(button("Use system default voice")).toBeUndefined();
  });

  // INTENT: 角色专属的官方音色落库时只是一个 idream-<uuid> 别名；以前界面只能写「声音版本 3」。
  it("names the official voice a pinned Pocket profile aliases", async () => {
    const data = pocketWorkspace();
    const pinned = { ...createdPocketProfile, status: "active" as const };
    data.voice = {
      ...data.voice,
      currentVoiceId: pinned.providerVoiceId,
      effectiveVoiceId: pinned.providerVoiceId,
      authoritySource: "character_clone",
      activeProfile: pinned,
      history: [pinned],
    };
    await render(data);
    const room = container.querySelector('[data-testid="voice-control-room"]');
    expect(room?.textContent).toContain("Anna");
    expect(room?.textContent).toContain("Character override");
    expect(
      container.querySelector('[data-voice-id="anna"]')?.textContent,
    ).toContain("In use");
    expect(container.querySelector('[data-voice-id="vera"]')?.textContent).not.toContain("In use");
    expect(button("Already in use")?.disabled).toBe(true);
  });

  // SPEC: 模型是一等选择 —— 两个模型都列出来，各自带运行状态，切换即换对应的操作区。
  it("offers both models with runtime status and swaps the builder with the choice", async () => {
    await render(pocketWorkspace());
    expect(modelRadio("voice-model-official")?.checked).toBe(true);
    expect(modelRadio("voice-model-clone")?.checked).toBe(false);
    const change = container.querySelector('[data-testid="voice-change"]');
    expect(change?.textContent).toContain("Pocket TTS · Official voices");
    expect(change?.textContent).toContain("Ming 3.0 TTS · Voice cloning");
    expect(change?.textContent).toContain("2 official English female voices");
    expect(change?.textContent).toContain("Engine MLX 0.4.3");
    expect(container.querySelector('[data-testid="voice-preset-builder"]')).not.toBeNull();
    expect(container.querySelector("#voice-candidate-builder")).toBeNull();

    await chooseModel("voice-model-clone");
    expect(container.querySelector('[data-testid="voice-preset-builder"]')).toBeNull();
    expect(container.querySelector("#voice-candidate-builder")).not.toBeNull();
    // SPEC: Fish 的演绎风格属于克隆这条路，直接可见，不再藏在折叠区。
    expect(container.textContent).toContain("Attraction intensity");
  });

  it("explains why a model cannot be chosen", async () => {
    const data = pocketWorkspace();
    data.voice.presetRuntime = { provider: "pocket_tts", runtimeStatus: "inactive", catalogVoiceIds: [] };
    data.voice.provider = "pocket_tts";
    data.voice.cloningAvailable = false;
    data.voice.runtimeEngine = "pocket_tts";
    await render(data);
    expect(modelRadio("voice-model-official")?.disabled).toBe(true);
    expect(container.textContent).toContain(
      "Official voices require the Pocket TTS runtime.",
    );
    expect(modelRadio("voice-model-clone")?.checked).toBe(true);
    expect(container.textContent).toContain("cloning not enabled");
    expect(container.textContent).toContain("Voice cloning is not enabled on this model.");
    expect(button("Clone and render preview")?.disabled).toBe(true);
  });

  it("auditions a catalog voice with the preview script and selects it", async () => {
    adminV2Request.mockResolvedValue({ contentType: "audio/wav", audioBase64: "AAAA" });
    await render(pocketWorkspace());
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Preview Anna"]')?.click();
    });
    expect(adminV2Request).toHaveBeenCalledWith(
      "/api/v2/admin/voice-defaults/preview",
      expect.objectContaining({
        body: expect.objectContaining({
          scope: "character_preset",
          provider: "pocket_tts",
          voiceId: "anna",
          text: expect.stringContaining("Mira"),
        }),
      }),
    );
    expect(container.querySelector<HTMLInputElement>("#character-official-voice-anna")?.checked).toBe(true);
    expect(container.querySelector('audio[aria-label="Preview Anna"]')?.getAttribute("src"))
      .toBe("data:audio/wav;base64,AAAA");
  });

  it("auditions Pocket voices independently of the Ming system default", async () => {
    adminV2Request.mockResolvedValue({ contentType: "audio/wav", audioBase64: "AAAA" });
    await render(mingWorkspace());
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Preview Anna"]')?.click();
    });
    expect(adminV2Request).toHaveBeenCalledWith(
      "/api/v2/admin/voice-defaults/preview",
      expect.objectContaining({
        body: expect.objectContaining({ scope: "character_preset", provider: "pocket_tts", voiceId: "anna" }),
      }),
    );
    expect(container.querySelector('audio[aria-label="Preview Anna"]')?.getAttribute("src"))
      .toBe("data:audio/wav;base64,AAAA");
  });

  it("does not show a late audition failure after selecting another voice", async () => {
    let rejectPreview: (cause: Error) => void = () => {};
    adminV2Request.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectPreview = reject; }));
    await render(pocketWorkspace());
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Preview Anna"]')?.click();
    });
    await chooseOfficialVoice("vera");
    await act(async () => rejectPreview(new Error("Anna preview failed after the voice selection changed")));

    expect(container.querySelector<HTMLInputElement>("#character-official-voice-vera")?.checked).toBe(true);
    expect(container.querySelector('[data-testid="voice-preset-builder"] [role="alert"]')).toBeNull();
  });

  it("shows an audition failure while its target is still selected", async () => {
    adminV2Request.mockRejectedValueOnce(new Error("Anna preview is unavailable"));
    await render(pocketWorkspace());
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Preview Anna"]')?.click();
    });
    expect(container.querySelector('[data-testid="voice-preset-builder"] [role="alert"]')?.textContent)
      .toContain("Anna preview is unavailable");
  });

  it("does not show a late audition failure after changing the preview script", async () => {
    let rejectPreview: (cause: Error) => void = () => {};
    adminV2Request.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectPreview = reject; }));
    await render(pocketWorkspace());
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Preview Anna"]')?.click();
    });
    await typeInto("#character-pocket-preset-preview-script", "This is the new preview script.");
    await act(async () => rejectPreview(new Error("The previous script failed")));
    expect(container.querySelector('[data-testid="voice-preset-builder"] [role="alert"]')).toBeNull();
  });

  it("does not play a late audition response after selecting another voice", async () => {
    let resolvePreview: (value: unknown) => void = () => {};
    adminV2Request.mockImplementationOnce(() => new Promise((resolve) => { resolvePreview = resolve; }));
    await render(pocketWorkspace());
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Preview Anna"]')?.click();
    });
    await chooseOfficialVoice("vera");
    await act(async () => resolvePreview({ contentType: "audio/wav", audioBase64: "AAAA" }));

    expect(container.querySelector<HTMLInputElement>("#character-official-voice-vera")?.checked).toBe(true);
    expect(container.querySelector('[data-testid="voice-preset-builder"] audio')).toBeNull();
  });

  // SPEC: 官方音色试听即审阅，点一下 = 生成候选 + 启用；后台仍是两条命令、两条审计，都不带原因。
  it.each(["pocket_tts", "fish_audio"])("applies an official voice and reads it back while %s owns system speech", async (systemProvider) => {
    adminV2Request.mockImplementation(async (path: string) =>
      path.endsWith("/voice-presets")
        ? { profile: createdPocketProfile, replacedCandidateProfileId: null, replayed: false }
        : { profile: { ...createdPocketProfile, status: "active" }, replacedActiveProfileId: null, replayed: false },
    );
    const data = systemProvider === "pocket_tts" ? pocketWorkspace() : mingWorkspace();
    await render(data);
    await chooseOfficialVoice("anna");
    await act(async () => button("Use as character voice")?.click());

    expect(dialog()).toBeNull();
    expect(adminV2Request).toHaveBeenCalledTimes(2);
    const [[createPath, create], [activatePath, activate]] = adminV2Request.mock.calls;
    expect(createPath).toBe("/api/v2/admin/characters/character-pocket-1/voice-presets");
    expect(create).toMatchObject({ method: "POST" });
    expect(create?.body).toEqual({
      presetVoiceId: "anna",
      sampleText: expect.stringContaining("Mira"),
    });
    expect(activatePath).toBe(
      "/api/v2/admin/characters/character-pocket-1/voice-profiles/voice-pocket-anna/activate",
    );
    // SPEC: 激活声明它以为的当前权威；服务端据此拒绝基于旧投影的写入。
    expect(activate?.body).toEqual({
      expectedActiveProfileId: null,
      expectedCurrentVoiceId: null,
    });
    expect(container.textContent).toContain("Voice changed. New chat speech now uses Anna.");
    data.voice.activeProfile = { ...createdPocketProfile, status: "active" };
    data.voice.currentVoiceId = createdPocketProfile.providerVoiceId;
    data.voice.effectiveVoiceId = createdPocketProfile.providerVoiceId;
    data.voice.authoritySource = "character_clone";
    await render(data);
    const room = container.querySelector('[data-testid="voice-control-room"]');
    expect(room?.textContent).toContain("Anna");
    expect(room?.textContent).toContain("Pocket TTS");
    expect(button("Already in use")?.disabled).toBe(true);
    expect(data.voice.systemDefaults.provider).toBe(systemProvider);
  });

  // INTENT: 候选已落库而启用失败时，重试不能再生成一个新候选（会归档刚才那个）。
  it("resumes a failed one-click apply at activation with the same key", async () => {
    let activations = 0;
    adminV2Request.mockImplementation(async (path: string) => {
      if (path.endsWith("/voice-presets")) {
        return { profile: createdPocketProfile, replacedCandidateProfileId: null, replayed: false };
      }
      activations += 1;
      if (activations === 1) throw new Error("Acknowledgement lost");
      return { profile: { ...createdPocketProfile, status: "active" }, replacedActiveProfileId: null, replayed: true };
    });
    await render(pocketWorkspace());
    await chooseOfficialVoice("anna");
    await act(async () => button("Use as character voice")?.click());
    // SPEC: 没有确认框兜住失败，错误就地显示在操作区。
    const builder = container.querySelector('[data-testid="voice-preset-builder"]');
    expect(builder?.querySelector('[role="alert"]')?.textContent).toContain("Acknowledgement lost");

    await act(async () => button("Use as character voice")?.click());

    const paths = adminV2Request.mock.calls.map(([path]) => path as string);
    expect(paths.filter((path) => path.endsWith("/voice-presets"))).toHaveLength(1);
    const activationKeys = adminV2Request.mock.calls
      .filter(([path]) => (path as string).endsWith("/activate"))
      .map(([, options]) => options?.idempotencyKey);
    expect(activationKeys).toHaveLength(2);
    expect(activationKeys[1]).toBe(activationKeys[0]);
    expect(builder?.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("Voice changed. New chat speech now uses Anna.");
  });

  it("resumes an unknown activation after leaving and reopening the Voice tab without creating another candidate", async () => {
    const storage = new Map<string, string>();
    const reopenJournal = () => {
      const journal = createCharacterCommandJournal({
        actorId: "operator-a",
        characterId: "character-pocket-1",
        storage: {
          getItem: (key) => storage.get(key) ?? null,
          setItem: (key, value) => { storage.set(key, value); },
          removeItem: (key) => { storage.delete(key); },
        },
      });
      idempotencyKeys = {
        take: journal.takeIdempotencyKey,
        release: journal.releaseIdempotencyKey,
        bindProfile: journal.bindVoiceProfile,
        releaseProfile: journal.releaseVoiceProfileKeys,
      };
    };
    reopenJournal();
    let activations = 0;
    const candidatesByKey = new Map<string, Omit<typeof createdPocketProfile, "id"> & { id: string }>();
    adminV2Request.mockImplementation(async (path: string, options: { idempotencyKey: string }) => {
      if (path.endsWith("/voice-presets")) {
        const existing = candidatesByKey.get(options.idempotencyKey);
        const profile = existing ?? { ...createdPocketProfile, id: `voice-pocket-anna-${candidatesByKey.size + 1}` };
        candidatesByKey.set(options.idempotencyKey, profile);
        return { profile, replacedCandidateProfileId: null, replayed: Boolean(existing) };
      }
      activations += 1;
      if (activations === 1) throw new Error("Acknowledgement lost");
      return { profile: { ...createdPocketProfile, status: "active" }, replacedActiveProfileId: null, replayed: true };
    });
    await render(pocketWorkspace());
    await chooseOfficialVoice("anna");
    await act(async () => button("Use as character voice")?.click());
    expect(activations).toBe(1);

    // CharacterWorkspace conditionally mounts Voice; its idempotency journal
    // survives tab switches while CharacterVoicePanel's local refs do not.
    await act(async () => root.render(null));
    reopenJournal();
    const afterCreate = pocketWorkspace();
    afterCreate.voice.candidateProfile = [...candidatesByKey.values()][0]!;
    afterCreate.voice.candidateRuntimeStatus = "ready";
    await render(afterCreate);
    await chooseOfficialVoice("anna");
    await act(async () => button("Use as character voice")?.click());

    expect(activations).toBe(2);
    // Recovery may replay the transport request. A second authority-side candidate
    // (and therefore a second generation) must never be created for that intent.
    expect(candidatesByKey.size).toBe(1);
    const creates = adminV2Request.mock.calls.filter(([path]) => path.endsWith("/voice-presets"));
    expect(new Set(creates.map(([, options]) => options.idempotencyKey)).size).toBe(1);
    const activationsSent = adminV2Request.mock.calls.filter(([path]) => path.endsWith("/activate"));
    expect(activationsSent[1]?.[0]).toBe(activationsSent[0]?.[0]);
    expect(activationsSent[1]?.[1]?.idempotencyKey).toBe(activationsSent[0]?.[1]?.idempotencyKey);
    expect(activationsSent[1]?.[1]?.body).toEqual(activationsSent[0]?.[1]?.body);
    expect(storage.size).toBe(0);
  });

  it("recovers a candidate creation with a lost acknowledgement after reopening Voice", async () => {
    let creates = 0;
    adminV2Request.mockImplementation(async (path: string) => {
      if (path.endsWith("/voice-presets")) {
        creates += 1;
        if (creates === 1) throw new Error("Candidate acknowledgement lost");
        return { profile: createdPocketProfile, replacedCandidateProfileId: null, replayed: true };
      }
      return { profile: { ...createdPocketProfile, status: "active" }, replacedActiveProfileId: null, replayed: false };
    });
    await render(pocketWorkspace());
    await chooseOfficialVoice("anna");
    await act(async () => button("Use as character voice")?.click());
    expect(container.textContent).toContain("Candidate acknowledgement lost");
    await act(async () => root.render(null));
    await render(pocketWorkspace());
    await chooseOfficialVoice("anna");
    await act(async () => button("Use as character voice")?.click());

    const createCalls = adminV2Request.mock.calls.filter(([path]) => path.endsWith("/voice-presets"));
    expect(createCalls).toHaveLength(2);
    expect(createCalls[1]?.[1]?.idempotencyKey).toBe(createCalls[0]?.[1]?.idempotencyKey);
    expect(createCalls[1]?.[1]?.body).toEqual(createCalls[0]?.[1]?.body);
    expect(adminV2Request.mock.calls.filter(([path]) => path.endsWith("/activate"))).toHaveLength(1);
    expect(container.textContent).toContain("Voice changed. New chat speech now uses Anna.");
  });

  it("settles a replayed creation only after its exact profile is known to be archived", async () => {
    let creates = 0;
    const sampleText = "Hello, I’m Mira. It’s good to hear from you.";
    const archived = { ...createdPocketProfile, id: "anna-archived", sampleText, status: "archived" as const };
    adminV2Request.mockImplementation(async (path: string) => {
      if (path.endsWith("/voice-presets")) {
        creates += 1;
        if (creates === 1) throw new Error("Candidate acknowledgement lost");
        return {
          profile: creates === 2 ? { ...archived, status: "candidate" } : { ...createdPocketProfile, id: "anna-new", sampleText },
          replacedCandidateProfileId: null, replayed: creates === 2,
        };
      }
      return { profile: { ...createdPocketProfile, id: "anna-new", status: "active" }, replacedActiveProfileId: null, replayed: false };
    });
    await render(pocketWorkspace());
    await chooseOfficialVoice("anna");
    await act(async () => button("Use as character voice")?.click());
    await act(async () => root.render(null));
    const afterReplacement = pocketWorkspace();
    afterReplacement.voice.history = [archived];
    await render(afterReplacement);
    await chooseOfficialVoice("anna");
    await act(async () => button("Use as character voice")?.click());
    expect(adminV2Request.mock.calls.filter(([path]) => path.endsWith("/activate"))).toHaveLength(0);
    // Resolving the old unknown request does not silently issue a new generation.
    // The next explicit apply receives a new identity and can create a candidate.
    await act(async () => button("Use as character voice")?.click());
    const createCalls = adminV2Request.mock.calls.filter(([path]) => path.endsWith("/voice-presets"));
    expect(createCalls).toHaveLength(3);
    expect(createCalls[1]?.[1]?.idempotencyKey).toBe(createCalls[0]?.[1]?.idempotencyKey);
    expect(createCalls[2]?.[1]?.idempotencyKey).not.toBe(createCalls[0]?.[1]?.idempotencyKey);
    expect(adminV2Request.mock.calls.filter(([path]) => path.endsWith("/activate"))).toHaveLength(1);
    expect(adminV2Request.mock.calls.at(-1)?.[0]).toContain("/anna-new/activate");
  });

  it("recognizes an activation that committed before its acknowledgement was lost", async () => {
    adminV2Request.mockImplementation(async (path: string) => {
      if (path.endsWith("/voice-presets")) {
        return { profile: createdPocketProfile, replacedCandidateProfileId: null, replayed: false };
      }
      throw new Error("Activation acknowledgement lost");
    });
    await render(pocketWorkspace());
    await chooseOfficialVoice("anna");
    await act(async () => button("Use as character voice")?.click());
    expect(container.textContent).toContain("Activation acknowledgement lost");

    // Returning to Voice with a newly read authority must identify the committed
    // profile as live, instead of using that new authority for a silent retry.
    await act(async () => root.render(null));
    const activated = pocketWorkspace();
    activated.voice.activeProfile = { ...createdPocketProfile, status: "active" };
    activated.voice.currentVoiceId = createdPocketProfile.providerVoiceId;
    activated.voice.effectiveVoiceId = createdPocketProfile.providerVoiceId;
    activated.voice.authoritySource = "character_clone";
    await render(activated);
    expect(button("Already in use")?.disabled).toBe(true);
    expect(container.querySelector('[data-testid="voice-control-room"]')?.textContent).toContain("Anna");
    expect(container.textContent).not.toContain("Activation acknowledgement lost");
    await act(async () => button("Already in use")?.click());
    expect(adminV2Request).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])("starts a fresh Anna after an unknown activation and replacement by Vera (activation committed: %s)", async (firstActivationCommitted) => {
    type Profile = NonNullable<ReturnType<typeof pocketWorkspace>["voice"]["activeProfile"]>;
    const receipts = new Map<string, Profile>();
    const profiles = new Map<string, Profile>();
    let live: Profile | null = null;
    let activationAttempts = 0;
    const authority = () => {
      const data = pocketWorkspace();
      data.voice.activeProfile = live;
      data.voice.history = [...profiles.values()];
      data.voice.currentVoiceId = live?.providerVoiceId ?? null;
      data.voice.effectiveVoiceId = live?.providerVoiceId ?? "vera";
      data.voice.authoritySource = live ? "character_clone" : "system_default";
      return data;
    };
    adminV2Request.mockImplementation(async (path: string, options: {
      idempotencyKey: string;
      body: { presetVoiceId: string; sampleText: string };
    }) => {
      if (path.endsWith("/voice-presets")) {
        const existing = receipts.get(options.idempotencyKey);
        if (existing) return { profile: existing, replacedCandidateProfileId: null, replayed: true };
        const profile: Profile = {
          ...createdPocketProfile,
          id: `voice-${options.body.presetVoiceId}-${receipts.size + 1}`,
          providerVoiceId: `provider-voice-${receipts.size + 1}`,
          presetVoiceId: options.body.presetVoiceId,
          sampleText: options.body.sampleText,
        };
        for (const [id, previous] of profiles) {
          if (previous.status === "candidate") profiles.set(id, { ...previous, status: "archived" });
        }
        receipts.set(options.idempotencyKey, profile);
        profiles.set(profile.id, profile);
        return { profile, replacedCandidateProfileId: null, replayed: false };
      }
      activationAttempts += 1;
      if (activationAttempts === 1 && !firstActivationCommitted) throw new Error("Activation acknowledgement lost");
      const profileId = path.split("/").at(-2)!;
      const profile = profiles.get(profileId)!;
      // Match Main's rule: a receipt for a former candidate does not make its
      // currently archived profile activatable again under a new activation key.
      if (profile.status !== "candidate") throw new Error("Voice profile is no longer an activatable candidate");
      if (live) profiles.set(live.id, { ...live, status: "archived" });
      live = { ...profile, status: "active" };
      profiles.set(live.id, live);
      if (activationAttempts === 1) throw new Error("Activation acknowledgement lost");
      return { profile: live, replacedActiveProfileId: null, replayed: false };
    });
    await render(authority());
    await chooseOfficialVoice("anna");
    await act(async () => button("Use as character voice")?.click());
    expect(container.textContent).toContain("Activation acknowledgement lost");

    await act(async () => root.render(null));
    await render(authority());
    if (firstActivationCommitted) expect(button("Already in use")?.disabled).toBe(true);
    await chooseOfficialVoice("vera");
    await act(async () => button("Use as character voice")?.click());

    await act(async () => root.render(null));
    await render(authority());
    await chooseOfficialVoice("anna");
    await act(async () => button("Use as character voice")?.click());
    expect(container.textContent).not.toContain("Voice profile is no longer an activatable candidate");
    expect(receipts.size).toBe(3);
    expect(authority().voice.activeProfile).toMatchObject({ id: "voice-anna-3", status: "active" });
    const annaCreates = adminV2Request.mock.calls.filter(([path, options]) =>
      path.endsWith("/voice-presets") && options.body.presetVoiceId === "anna");
    expect(annaCreates).toHaveLength(2);
    expect(annaCreates[1]?.[1]?.idempotencyKey).not.toBe(annaCreates[0]?.[1]?.idempotencyKey);
  });

  it("forgets the confirmed prepared candidate before resetting and reapplying in the same mounted panel", async () => {
    let creations = 0;
    let activations = 0;
    adminV2Request.mockImplementation(async (path: string, options: { body: { sampleText: string } }) => {
      if (path.endsWith("/voice-presets")) {
        creations += 1;
        return {
          profile: { ...createdPocketProfile, id: `anna-${creations}`, sampleText: options.body.sampleText },
          replacedCandidateProfileId: null, replayed: false,
        };
      }
      if (path.endsWith("/voice-defaults/reset")) return { replayed: false };
      activations += 1;
      if (activations === 1) throw new Error("Activation acknowledgement lost");
      if (path.endsWith("/anna-1/activate")) throw new Error("Voice profile is no longer an activatable candidate");
      return { profile: { ...createdPocketProfile, id: "anna-2", status: "active" }, replacedActiveProfileId: null, replayed: false };
    });
    await render(pocketWorkspace());
    await chooseOfficialVoice("anna");
    await act(async () => button("Use as character voice")?.click());
    const confirmed = pocketWorkspace();
    confirmed.voice.activeProfile = {
      ...createdPocketProfile, id: "anna-1", status: "active",
      sampleText: "Hello, I’m Mira. It’s good to hear from you.",
    };
    confirmed.voice.currentVoiceId = createdPocketProfile.providerVoiceId;
    confirmed.voice.effectiveVoiceId = createdPocketProfile.providerVoiceId;
    confirmed.voice.authoritySource = "character_clone";
    await render(confirmed);
    expect(button("Already in use")?.disabled).toBe(true);
    await act(async () => button("Use system default voice")?.click());
    await confirmDialog("Use system default voice");
    await render(pocketWorkspace());
    await chooseOfficialVoice("anna");
    await act(async () => button("Use as character voice")?.click());

    expect(creations).toBe(2);
    expect(container.textContent).not.toContain("Voice profile is no longer an activatable candidate");
    expect(adminV2Request.mock.calls.at(-1)?.[0]).toContain("/anna-2/activate");
  });

  it("does not let a late activation refresh clear another tab's new candidate key", async () => {
    let finishRefresh: () => void = () => {};
    let mutations = 0;
    const delayedRefresh: typeof runCommittedMutation = async (input) => {
      const result = await input.commit();
      mutations += 1;
      if (mutations === 2) await new Promise<void>(resolve => { finishRefresh = resolve; });
      input.afterRefresh?.();
      return { result, refreshed: true };
    };
    adminV2Request.mockImplementation(async (path: string) => path.endsWith("/voice-presets")
      ? { profile: createdPocketProfile, replacedCandidateProfileId: null, replayed: false }
      : { profile: { ...createdPocketProfile, status: "active" }, replacedActiveProfileId: null, replayed: false });
    await render(pocketWorkspace(), {}, delayedRefresh);
    await chooseOfficialVoice("anna");
    await act(async () => button("Use as character voice")?.click());
    expect(mutations).toBe(2);
    const createBody = adminV2Request.mock.calls[0]?.[1]?.body;
    const signature = `voice-preset:character-pocket-1:${JSON.stringify(createBody)}`;
    idempotencyKeys.release(signature);
    const newerKey = idempotencyKeys.take(signature);
    idempotencyKeys.bindProfile(signature, newerKey, "another-tabs-new-candidate");

    await act(async () => finishRefresh());
    expect(idempotencyKeys.take(signature)).toBe(newerKey);
  });

  it("does not settle an unknown candidate when another profile with the same voice is active", async () => {
    const body = { presetVoiceId: "anna", sampleText: "Hello, I’m Mira. It’s good to hear from you." };
    const createSignature = `voice-preset:character-pocket-1:${JSON.stringify(body)}`;
    const activateSignature = `voice-activate:character-pocket-1:unknown-anna:${JSON.stringify({
      expectedActiveProfileId: null, expectedCurrentVoiceId: null,
    })}`;
    const createKey = idempotencyKeys.take(createSignature);
    const activateKey = idempotencyKeys.take(activateSignature);
    idempotencyKeys.bindProfile(createSignature, createKey, "unknown-anna");
    idempotencyKeys.bindProfile(activateSignature, activateKey, "unknown-anna");
    const data = pocketWorkspace();
    data.voice.activeProfile = { ...createdPocketProfile, id: "different-anna", sampleText: body.sampleText, status: "active" };
    data.voice.currentVoiceId = createdPocketProfile.providerVoiceId;
    data.voice.effectiveVoiceId = createdPocketProfile.providerVoiceId;
    data.voice.authoritySource = "character_clone";
    await render(data);

    expect(button("Already in use")?.disabled).toBe(true);
    expect(idempotencyKeys.take(createSignature)).toBe(createKey);
    expect(idempotencyKeys.take(activateSignature)).toBe(activateKey);
    expect(adminV2Request).not.toHaveBeenCalled();
  });

  // INTENT: 工作区在写入期间把所有写权限置为 false（写锁）。实测一键应用时文案中途从
  //         「设为角色声音」变成了「提交为候选」——应用还是只提交，必须按点击那一刻的权限定。
  it("keeps the apply decision it was clicked with while the workspace write lock flips permissions", async () => {
    let releaseCreate: () => void = () => {};
    adminV2Request.mockImplementation(async (path: string) => {
      if (path.endsWith("/voice-presets")) {
        await new Promise<void>((resolve) => { releaseCreate = resolve; });
        return { profile: createdPocketProfile, replacedCandidateProfileId: null, replayed: false };
      }
      return { profile: { ...createdPocketProfile, status: "active" }, replacedActiveProfileId: null, replayed: false };
    });
    await render(pocketWorkspace());
    await chooseOfficialVoice("anna");
    await act(async () => { button("Use as character voice")?.click(); });
    await render(pocketWorkspace(), { canActivate: false, canWrite: false });
    expect(button("Applying voice…")).toBeDefined();
    expect(button("Submit as candidate")).toBeUndefined();
    expect(container.textContent).not.toContain(
      "Read-only: character write permission is required to change the voice.",
    );
    await act(async () => releaseCreate());
    expect(adminV2Request.mock.calls.map(([path]) => path)).toEqual([
      "/api/v2/admin/characters/character-pocket-1/voice-presets",
      "/api/v2/admin/characters/character-pocket-1/voice-profiles/voice-pocket-anna/activate",
    ]);
    expect(container.textContent).toContain("Voice changed. New chat speech now uses Anna.");
  });

  it("only submits a candidate when the operator cannot publish", async () => {
    adminV2Request.mockResolvedValue({
      profile: createdPocketProfile,
      replacedCandidateProfileId: null,
      replayed: false,
    });
    await render(pocketWorkspace(), { canActivate: false });
    await chooseOfficialVoice("anna");
    expect(button("Use as character voice")).toBeUndefined();
    await act(async () => button("Submit as candidate")?.click());
    expect(dialog()).toBeNull();
    expect(adminV2Request).toHaveBeenCalledTimes(1);
    expect(adminV2Request.mock.calls[0]?.[0]).toContain("/voice-presets");
    expect(container.textContent).toContain("teammate with publish permission");
  });

  it("sends the authored delivery settings with the voice clone reference", async () => {
    adminV2Request.mockResolvedValue({
      profile: candidateProfile,
      replacedCandidateProfileId: null,
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
    await act(async () => {
      container
        .querySelector<HTMLFormElement>("#voice-candidate-builder")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    // SPEC: 克隆只生成候选，不动线上声音，提交即执行。
    expect(dialog()).toBeNull();
    expect(adminV2Request).toHaveBeenCalledTimes(1);
    const body = adminV2Request.mock.calls[0]?.[1]?.form as FormData;
    // SPEC: 声音身份（参考音频 + 逐字稿）与表演方向（delivery）是两件事，一次提交都要带上。
    expect(body.get("audio")).toBe(file);
    expect(body.get("referenceText")).toBe("Come a little closer.");
    expect(body.has("reason")).toBe(false);
    expect(JSON.parse(String(body.get("delivery")))).toMatchObject({
      preset: "sensual",
      repetitionPenalty: expect.any(Number),
    });
  });

  it("names the exact authority it expects when activating a reviewed candidate", async () => {
    adminV2Request.mockResolvedValue({
      profile: { ...candidateProfile, status: "active" },
      replacedActiveProfileId: "voice-active-1",
      replayed: false,
    });
    await render();
    const review = container.querySelector('[data-testid="voice-candidate-primary-action"]');
    expect(review?.textContent).toContain("Creating a candidate keeps the current voice unchanged.");
    expect(review?.querySelector('audio[aria-label="Candidate voice preview"]')?.getAttribute("src"))
      .toBe("/voice-candidate-1.mp3");

    await act(async () => button("Activate voice")?.click());

    expect(dialog()).toBeNull();
    expect(adminV2Request).toHaveBeenCalledTimes(1);
    const [path, options] = adminV2Request.mock.calls[0] ?? [];
    expect(path).toContain("/voice-profiles/voice-candidate-1/activate");
    expect(options?.body).toEqual({
      expectedActiveProfileId: "voice-active-1",
      expectedCurrentVoiceId: "fish-active-1",
    });
  });

  // SPEC: 重试一次失败的激活必须复用同一个幂等键。
  it("replays a failed activation under the same idempotency key", async () => {
    adminV2Request.mockRejectedValue(new Error("network down"));
    await render();
    await act(async () => button("Activate voice")?.click());
    const review = container.querySelector('[data-testid="voice-candidate-primary-action"]');
    expect(review?.querySelector('[role="alert"]')?.textContent).toContain("network down");
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
    expect(button("Activate voice")?.disabled).toBe(true);
    expect(container.textContent).toContain(
      "The candidate provider must be ready",
    );
    expect(adminV2Request).not.toHaveBeenCalled();
  });

  // INTENT: 恢复默认针对的是某个线上权威；它被替换，打开的确认框就作废。
  it("lapses an open reset when the live authority changes", async () => {
    await render();
    await act(async () => button("Use system default voice")?.click());
    expect(dialog()).not.toBeNull();
    const changed = withCandidate();
    await render({ ...changed, voice: { ...changed.voice, currentVoiceId: "new-live-pointer" } });
    expect(dialog()).toBeNull();
    expect(adminV2Request).not.toHaveBeenCalled();
  });

  it("restores the system default through a confirmed reset", async () => {
    adminV2Request.mockResolvedValue({ currentVoiceId: null, archivedProfileId: "voice-active-1", replayed: false });
    await render();
    await act(async () => button("Use system default voice")?.click());
    expect(dialog()?.textContent).toContain(
      "Mira goes back to inheriting the system default voice",
    );
    await confirmDialog("Use system default voice");
    const [path, options] = adminV2Request.mock.calls[0] ?? [];
    expect(path).toBe("/api/v2/admin/characters/character-voice-1/voice-defaults/reset");
    expect(options?.body).toEqual({
      expectedActiveProfileId: "voice-active-1",
      expectedCurrentVoiceId: "fish-active-1",
    });
  });

  it("keeps secondary configuration folded away", async () => {
    await render();
    expect(container.querySelector('[data-testid="system-voice-defaults"]'))
      .not.toBeNull();
    const systemDefaultsSummary = container.querySelector(
      '[data-testid="system-voice-defaults"] > summary',
    );
    // SPEC: 窄屏时操作入口独占一行，不能把说明文案压成逐词换行。
    expect(systemDefaultsSummary?.className).toContain("flex-col");
    expect(systemDefaultsSummary?.className).toContain("sm:flex-row");
    expect(container.textContent).toContain("System performance direction");
    // SPEC: 次要配置默认折叠——一屏只留更换声音这一件事。
    expect([...container.querySelectorAll("details")].length).toBeGreaterThan(0);
    expect([...container.querySelectorAll("details")]
      .every((element) => element.open === false)).toBe(true);
    expect(
      container.querySelector('audio[aria-label="Active character voice preview"]')
        ?.getAttribute("src"),
    ).toBe("/voice-active-1.mp3");
  });

  // SPEC: 系统语音默认值是从单个角色页面能改到全站的唯一一处写操作。
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
    await confirmDialog("Save system defaults");
    expect(adminV2Request).toHaveBeenCalledWith(
      "/api/v2/admin/voice-defaults",
      expect.objectContaining({
        body: expect.objectContaining({ provider: "fish_audio" }),
      }),
    );
    expect(adminV2Request.mock.calls[0]?.[1]?.body).not.toHaveProperty("reason");
  });

  it("hides unsupported Ming sampling controls while retaining saved values on a delivery edit", async () => {
    const data = withCandidate();
    data.voice.runtimeModel = "ming-3.0-tts-0.5b-8bit";
    data.voice.systemDefaults.delivery = { ...data.voice.systemDefaults.delivery,
      temperature: 0.93, topP: 0.84, topK: 63, repetitionPenalty: 1.24 };
    await render(data);
    expect(container.textContent).not.toContain("Advanced Fish sampling");
    expect(container.querySelectorAll('input[type="number"]')).toHaveLength(0);
    expect(container.textContent).toContain("Ming uses fixed sampling. Saved advanced settings are retained for other models.");
    const system = container.querySelector('[data-testid="system-voice-defaults"]')!;
    const natural = [...system.querySelectorAll("button")].find(item => item.textContent?.includes("Natural"))!;
    await act(async () => natural.click());
    await act(async () => button("Save system defaults")?.click());
    adminV2Request.mockResolvedValue({ replayed: false });
    await confirmDialog("Save system defaults");
    expect(adminV2Request).toHaveBeenCalledWith("/api/v2/admin/voice-defaults", expect.objectContaining({
      body: expect.objectContaining({ delivery: { ...data.voice.systemDefaults.delivery, preset: "natural" } }),
    }));
  });

  it("retains the four advanced sampling controls for Breeze in both editors", async () => {
    const data = withCandidate();
    data.voice.runtimeModel = "breeze-tts-2-mlx-8bit";
    await render(data);
    expect(container.querySelectorAll('input[type="number"]')).toHaveLength(8);
    const system = container.querySelector('[data-testid="system-voice-defaults"]')!;
    expect([...system.querySelectorAll<HTMLInputElement>('input[type="number"]')].map(input => input.value)).toEqual([
      data.voice.systemDefaults.delivery.temperature, data.voice.systemDefaults.delivery.topP,
      data.voice.systemDefaults.delivery.topK, data.voice.systemDefaults.delivery.repetitionPenalty,
    ].map(String));
    expect(container.textContent).not.toContain("Ming uses fixed sampling.");
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
    });
    await act(async () => button("Save system defaults")?.click());
    adminV2Request.mockResolvedValue({ replayed: false });
    await confirmDialog("Save system defaults");
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

  it("keeps a failed system save dialog open for an idempotent retry", async () => {
    await render();
    await act(async () => button("Save system defaults")?.click());
    adminV2Request.mockRejectedValueOnce(new Error("Network interrupted"));
    await act(async () => dialogButton("Save system defaults")?.click());
    expect(dialog()?.querySelector('[role="alert"]')).not.toBeNull();
    const firstKey = adminV2Request.mock.calls[0]?.[1].idempotencyKey;
    adminV2Request.mockResolvedValueOnce({ replayed: true });
    await act(async () => dialogButton("Save system defaults")?.click());
    expect(adminV2Request.mock.calls[1]?.[1].idempotencyKey).toBe(firstKey);
  });

  it("does not label Pocket speech with unused Fish performance controls", async () => {
    const data = characterWorkspaceDetail({ voice: { systemDefaults: { provider: "pocket_tts" }, effectiveVoiceId: "vera" } });
    await render(data);
    expect(container.querySelector('[data-testid="voice-control-room"]')?.textContent).not.toContain("Sensual");
  });

  it("keeps system mapping fields read-only without generation config permission", async () => {
    await render(withCandidate(), { canManageDefaults: false });
    const fields = [...container.querySelectorAll<HTMLSelectElement>('[data-testid="system-voice-defaults"] select')];
    expect(fields).toHaveLength(4);
    expect(fields.every((field) => field.disabled)).toBe(true);
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
    adminV2Request.mockRejectedValueOnce(new Error("Acknowledgement lost"));
    await act(async () => dialogButton("Save system defaults")?.click());
    const firstOptions = adminV2Request.mock.calls[0]?.[1];
    await render({ ...data, voice: { ...data.voice, systemDefaults: { ...data.voice.systemDefaults, settingVersion: 9, defaultVoiceId: "another" } } });
    expect(dialog()?.textContent).toContain("System fallback identity");
    adminV2Request.mockResolvedValueOnce({ replayed: true });
    await act(async () => dialogButton("Save system defaults")?.click());
    expect(adminV2Request.mock.calls[1]?.[1]).toEqual(firstOptions);
  });

  it("keeps a confirmation open with an error when write permission is revoked", async () => {
    await render();
    await act(async () => button("Save system defaults")?.click());
    await render(withCandidate(), { canManageDefaults: false });
    await act(async () => dialogButton("Save system defaults")?.click());
    expect(dialog()).not.toBeNull();
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain("You no longer have permission");
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
