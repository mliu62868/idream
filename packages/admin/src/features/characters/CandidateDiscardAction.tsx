"use client";

import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { useState } from "react";
import { useAdminI18n } from "@/components/admin/i18n";
import { characterCommandMessage, renderCharacterCommandMessage, type CharacterCommandMessage } from "./character-command-copy";
import { useCharacterWorkspaceActions } from "./character-workspace-actions";
import { commandSubmissionMessage, submitCharacterReleaseCommand } from "./release-command";

/**
 * SPEC: 候选冻结草稿时（candidate-release-guard），在被拦的地方就地放弃候选，不用跑去发布页。
 * INVARIANT: 服务端冻结不放宽；这里走和发布页相同的 withdraw durable command 与写入锁。
 */
export function CandidateDiscardAction({ data }: { readonly data: CharacterWorkspaceDetail }) {
  const { t } = useAdminI18n();
  const actions = useCharacterWorkspaceActions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CharacterCommandMessage | null>(null);
  const candidate = data.releases.find(({ release }) => release.status === "approved")?.release;
  if (!actions || !candidate || !actions.permissions.publishRelease) return null;
  const { journal, writesLocked } = actions;

  async function discard() {
    if (!candidate || writesLocked || busy) return;
    if (!journal.beginSubmission(characterCommandMessage("Submitting {action}. Character writes stay locked until command acceptance is known.", { action: "Release withdraw" }))) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await submitCharacterReleaseCommand(journal, {
        characterId: data.character.id,
        kind: "withdraw",
        release: { id: candidate.id, version: candidate.version },
        summary: t("Discard candidate"),
      });
      if (outcome.kind !== "accepted") setError(commandSubmissionMessage(outcome, "Release withdraw"));
    } catch (cause) {
      journal.abortSubmission();
      setError(cause instanceof Error ? cause.message : t("Could not discard candidate"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        className="min-h-9 font-semibold underline disabled:opacity-50"
        disabled={busy || writesLocked}
        onClick={() => void discard()}
        type="button"
      >
        {t("Discard candidate and keep editing")}
      </button>
      {error ? <span role="alert">{renderCharacterCommandMessage(error, t)}</span> : null}
    </span>
  );
}
