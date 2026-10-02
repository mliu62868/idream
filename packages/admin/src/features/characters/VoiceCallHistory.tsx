"use client";

import { useState } from "react";
import type { CharacterVoiceCallHistory } from "@idream/shared/admin";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import { useAdminI18n } from "@/components/admin/i18n";
import { WorkspaceButton } from "@/features/operations/WorkspaceUi";

export function VoiceCallHistory({ characterId }: { characterId: string }) {
  const { t } = useAdminI18n();
  const [data, setData] = useState<CharacterVoiceCallHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true); setError(null);
    try { setData(await adminV2Operation("GET /api/v2/admin/characters/:id/voice-calls", { path: { id: characterId } })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("Could not load call history")); }
    finally { setBusy(false); }
  }
  return <section className="rounded-xl border border-[var(--ad-border)] p-4" aria-label={t("Voice call history")}>
    <div className="flex items-center justify-between gap-3"><h3 className="font-semibold">{t("Voice call history")}</h3>
      <WorkspaceButton type="button" disabled={busy} onClick={() => void load()}>{busy ? t("Loading…") : t("Load / refresh calls")}</WorkspaceButton>
    </div>
    {error ? <p role="alert" className="mt-3 text-sm text-[var(--ad-red-text)]">{error}</p> : null}
    {data?.items.length === 0 ? <p className="mt-3 text-sm text-[var(--ad-text-muted)]">{t("No voice calls for this Character")}</p> : null}
    <div className="mt-3 space-y-3">{data?.items.map(call => <details key={call.id} className="rounded-lg border border-[var(--ad-border)] p-3">
      <summary className="cursor-pointer text-sm">{call.status} · {new Date(call.startedAt).toLocaleString()} · {(call.connectedMs / 1000).toFixed(1)}s · {(call.voiceDurationMs / 60_000).toFixed(2)} {t("voice minutes")} · {call.costDreamcoins}/{call.maxCostDreamcoins} {t("coins")}</summary>
      <dl className="mt-3 grid gap-1 break-all text-xs text-[var(--ad-text-muted)]">
        <div>{t("Call")}: {call.id}</div><div>{t("User")}: {call.userId}</div><div>{t("Session")}: {call.sessionId}</div>
        <div>{call.provider} · {call.language} · {call.endReason ?? "—"} · {call.settledAt ?? t("Not settled")}</div>
      </dl>
      {call.utterances.map(turn => <p key={turn.id} className="mt-2 break-all border-t border-[var(--ad-border)] pt-2 text-xs text-[var(--ad-text-muted)]">
        {turn.status} · {t("Turn")} {turn.turnId ?? "—"} · {t("attempt")} {turn.replyAttempt ?? "—"} · {t("Voice")} {turn.voiceRequestId ?? "—"} · {t("asset")} {turn.mediaAssetId ?? "—"} · {(turn.durationMs / 1000).toFixed(2)}s · {turn.costDreamcoins} {t("coins")} {turn.errorCode ? `· ${turn.errorCode}` : ""}
      </p>)}
    </details>)}</div>
  </section>;
}
