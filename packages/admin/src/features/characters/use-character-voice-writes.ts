import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { useEffect, useRef, useState } from "react";
import { operatorErrorCopy, type OperatorErrorCopy } from "@/components/admin/ui/request-error-copy";
import { voiceProviderLabel } from "@/features/voice/VoiceSettingsControls";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import {
  activationResultMessage,
  cloneResultMessage,
  isTerminalVoiceProfile,
  resetResultMessage,
  terminalVoiceProfileIds,
  voiceActivateSignature,
  voiceCloneForm,
  voiceCloneSignature,
  voiceExpectedAuthority,
  voicePresetCreateSignature,
  voiceResetSignature,
  type DirectAction,
  type RunCommittedMutation,
  type VoiceBusyAction,
  type VoiceCloneDraft,
} from "./character-voice-model";

// SPEC: picking, cloning and activating a voice apply on click. No write asks for a
// reason. Only reset reaches beyond this pick and gets a ConfirmDialog (owned by the
// panel): it drops this Character's own voice.
// INTENT: 这里只编排声音写入（幂等键、两段式应用、失败落位）；文案与请求形状来自
//         character-voice-model，界面状态归面板。
export function useCharacterVoiceWrites({
  data,
  runCommittedMutation,
  takeIdempotencyKey,
  releaseIdempotencyKey,
  bindVoiceProfile,
  releaseVoiceProfileKeys,
}: {
  data: CharacterWorkspaceDetail;
  runCommittedMutation: RunCommittedMutation;
  takeIdempotencyKey: (signature: string) => string;
  releaseIdempotencyKey: (signature: string) => void;
  bindVoiceProfile: (signature: string, key: string, profileId: string) => void;
  releaseVoiceProfileKeys: (profileId: string) => void;
}) {
  const voice = data.voice;
  const active = voice.activeProfile;
  const candidate = voice.candidateProfile;

  // One-click apply creates a candidate and then activates it. If activation fails
  // after the candidate committed, a retry of the same apply resumes at activation.
  // The create key stays in the workspace journal until activation is confirmed,
  // so remounting this panel can also recover the same candidate by receipt replay.
  const preparedPreset = useRef<{ signature: string; profileId: string } | null>(null);

  useEffect(() => {
    for (const profileId of terminalVoiceProfileIds(active, voice.history)) {
      releaseVoiceProfileKeys(profileId);
      if (preparedPreset.current?.profileId === profileId) preparedPreset.current = null;
    }
  }, [active, voice.history, releaseVoiceProfileKeys]);

  const [busyAction, setBusyAction] = useState<VoiceBusyAction | null>(null);
  const busy = busyAction !== null;
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ action: DirectAction; copy: OperatorErrorCopy } | null>(null);

  // Direct writes have no dialog to hold a failure, so it renders beside the control.
  async function runDirectAction(action: DirectAction, write: () => Promise<void>) {
    if (busy) return;
    setBusyAction(action);
    setMessage(null);
    setActionError(null);
    try {
      await write();
    } catch (cause) {
      setActionError({ action, copy: operatorErrorCopy(cause) });
    } finally {
      setBusyAction(null);
    }
  }

  // `activate` is read at click time: the write lock revokes permissions mid-write,
  // and the outcome must follow what the operator clicked.
  function applyOfficialVoice(input: {
    readonly voiceId: string;
    readonly sampleText: string;
    readonly activate: boolean;
    readonly appliedMessage: string;
    readonly onApplied: () => void;
  }) {
    const { voiceId, sampleText, activate } = input;
    return runDirectAction("preset", async () => {
      const body = { presetVoiceId: voiceId, sampleText };
      const createSignature = voicePresetCreateSignature(data.character.id, body);
      const expectedAuthority = voiceExpectedAuthority(voice);
      let profileId = preparedPreset.current?.signature === createSignature
        ? preparedPreset.current.profileId
        : null;
      if (!profileId) {
        const created = await runCommittedMutation({
          action: "Create Pocket TTS voice candidate",
          commit: async () => {
            const key = takeIdempotencyKey(createSignature);
            const result = await adminV2Operation("POST /api/v2/admin/characters/:id/voice-presets", {
              path: { id: data.character.id },
              replayIdempotencyKey: key,
              body,
            });
            bindVoiceProfile(createSignature, key, result.profile.id);
            profileId = result.profile.id;
            preparedPreset.current = { signature: createSignature, profileId: result.profile.id };
            // A lost creation acknowledgement may be replayed after another action
            // already archived that exact profile. Resolve it before a new apply.
            if (isTerminalVoiceProfile(voice, result.profile.id)) {
              releaseVoiceProfileKeys(result.profile.id);
              preparedPreset.current = null;
            }
            return result;
          },
          afterRefresh: activate ? undefined : () => {
            if (profileId) releaseVoiceProfileKeys(profileId);
          },
        });
        profileId = created.result.profile.id;
        // A recovered terminal profile is settled; a new generation requires a
        // fresh apply, not an implicit second write inside the original recovery.
        if (preparedPreset.current === null) return;
      }
      if (!activate) {
        preparedPreset.current = null;
        setMessage("Candidate submitted. It takes effect after a teammate with publish permission activates it.");
        return;
      }
      const activateSignature = voiceActivateSignature(data.character.id, profileId, expectedAuthority);
      const createdProfileId = profileId;
      await runCommittedMutation({
        action: "Activate Pocket TTS voice",
        commit: () => {
          const key = takeIdempotencyKey(activateSignature);
          bindVoiceProfile(activateSignature, key, createdProfileId);
          return adminV2Operation("POST /api/v2/admin/characters/:id/voice-profiles/:profileId/activate", {
            path: { id: data.character.id, profileId: createdProfileId },
            replayIdempotencyKey: key,
            body: expectedAuthority,
          });
        },
        afterRefresh: () => releaseVoiceProfileKeys(createdProfileId),
      });
      preparedPreset.current = null;
      input.onApplied();
      setMessage(input.appliedMessage);
    });
  }

  function createClone(input: {
    readonly draft: VoiceCloneDraft;
    readonly providerLabel: string;
    readonly onCommitted: () => void;
  }) {
    const { draft } = input;
    return runDirectAction("clone", async () => {
      const form = voiceCloneForm(draft);
      const signature = voiceCloneSignature(data.character.id, draft);
      const mutation = await runCommittedMutation({
        action: `${input.providerLabel} voice clone`,
        commit: () =>
          adminV2Operation("POST /api/v2/admin/characters/:id/voice-clones", {
            path: { id: data.character.id },
            replayIdempotencyKey: takeIdempotencyKey(signature),
            form,
          }),
        afterRefresh: () => {
          releaseIdempotencyKey(signature);
          input.onCommitted();
        },
      });
      setMessage(cloneResultMessage(mutation.result.replayed));
    });
  }

  function activateCandidate() {
    if (!candidate) return;
    return runDirectAction("activate", async () => {
      const body = voiceExpectedAuthority(voice);
      const signature = voiceActivateSignature(data.character.id, candidate.id, body);
      const mutation = await runCommittedMutation({
        action: `Activate ${voiceProviderLabel(candidate.provider, candidate.model)} voice`,
        commit: () =>
          adminV2Operation("POST /api/v2/admin/characters/:id/voice-profiles/:profileId/activate", {
            path: { id: data.character.id, profileId: candidate.id },
            replayIdempotencyKey: takeIdempotencyKey(signature),
            body,
          }),
        afterRefresh: () => releaseIdempotencyKey(signature),
      });
      setMessage(activationResultMessage(mutation.result.replayed));
    });
  }

  // Dialog actions throw so ConfirmDialog stays open and shows the failure.
  async function resetToSystemDefault(canActivate: boolean) {
    if (!canActivate || busy || voice.currentVoiceId === null) return;
    setBusyAction("reset");
    setMessage(null);
    const body = voiceExpectedAuthority(voice);
    const signature = voiceResetSignature(data.character.id, body);
    try {
      const mutation = await runCommittedMutation({
        action: "Reset character voice to system default",
        commit: () =>
          adminV2Operation("POST /api/v2/admin/characters/:id/voice-defaults/reset", {
            path: { id: data.character.id },
            replayIdempotencyKey: takeIdempotencyKey(signature),
            body,
          }),
        afterRefresh: () => releaseIdempotencyKey(signature),
      });
      setMessage(resetResultMessage(mutation.result.replayed));
    } finally {
      setBusyAction(null);
    }
  }

  return {
    busyAction,
    busy,
    message,
    actionError,
    applyOfficialVoice,
    createClone,
    activateCandidate,
    resetToSystemDefault,
  };
}
