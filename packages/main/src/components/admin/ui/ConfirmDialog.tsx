"use client";
import { useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useAdminI18n } from "@/components/admin/i18n";
import { GhostButton, PrimaryButton } from "./buttons";
import { INPUT_CLASS } from "./FormPage";

export type ConfirmSpec = {
  title: string;
  summary?: ReactNode;
  /** 破坏性操作：要求输入实体名称（不再敲内部 ID —— spec §7）。 */
  destructive?: { expectedName: string };
  submitLabel: string;
  onSubmit: (reason: string) => Promise<void>;
};

// SPEC: 全后台写操作统一确认框。reason ≥3 必填（后端审计契约）；
// destructive 时额外要求名称打对。onSubmit 抛错则就地显示，不关框。
export function ConfirmDialog({ spec, onClose }: { spec: ConfirmSpec; onClose: () => void }) {
  const { t } = useAdminI18n();
  const [reason, setReason] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameOk = !spec.destructive || nameInput.trim() === spec.destructive.expectedName;
  const canSubmit = !busy && reason.trim().length >= 3 && nameOk;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await spec.onSubmit(reason.trim());
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : t("Request failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/20 p-4">
      <div className="w-full max-w-md rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-6">
        <h3 className="text-sm font-semibold text-[var(--ad-ink)]">{spec.title}</h3>
        {spec.summary ? (
          <div className="mt-2 text-sm text-[var(--ad-text-muted)]">{spec.summary}</div>
        ) : null}
        <div className="mt-4 space-y-3">
          <input
            aria-label={t("Reason (≥3)")}
            className={INPUT_CLASS}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t("Reason (≥3)")}
            value={reason}
          />
          {spec.destructive ? (
            <input
              aria-label={t("Type the name to confirm")}
              className={INPUT_CLASS}
              onChange={(event) => setNameInput(event.target.value)}
              placeholder={`${t("Type the name to confirm")}: ${spec.destructive.expectedName}`}
              value={nameInput}
            />
          ) : null}
          {error ? <p className="text-sm text-[var(--ad-red-text)]">{error}</p> : null}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <GhostButton disabled={busy} onClick={onClose}>
            {t("Cancel")}
          </GhostButton>
          <PrimaryButton disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {spec.submitLabel}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
