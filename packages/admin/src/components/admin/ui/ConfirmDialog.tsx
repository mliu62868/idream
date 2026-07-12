"use client";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Loader2 } from "lucide-react";
import { useAdminI18n } from "@/components/admin/i18n";
import { GhostButton, PrimaryButton } from "./buttons";
import { INPUT_CLASS } from "./FormPage";

export type ConfirmSpec = {
  title: string;
  summary?: ReactNode;
  /** 破坏性操作：要求输入实体名称（不再敲内部 ID —— spec §7）。 */
  destructive?: { expectedName: string; inputLabel?: string };
  /** 后端写操作是否收 reason（默认 true）。false 时不显示 reason 输入、不拿它门槛提交，
   * onSubmit 收到 ""——后端契约无 reason 字段的操作不该让运营填一个会被丢弃的原因（T14 评审规则）。 */
  requireReason?: boolean;
  reasonLabel?: string;
  submitLabel: string;
  onSubmit: (reason: string) => Promise<void>;
};

// SPEC: 全后台写操作统一确认框。reason ≥3 必填（后端审计契约），除非 requireReason===false；
// destructive 时额外要求名称打对。onSubmit 抛错则就地显示，不关框。
export function ConfirmDialog({ spec, onClose }: { spec: ConfirmSpec; onClose: () => void }) {
  const { t } = useAdminI18n();
  const [reason, setReason] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const requireReason = spec.requireReason ?? true;
  const reasonLabel = spec.reasonLabel ?? t("Reason (≥3)");
  const destructiveInputLabel = spec.destructive?.inputLabel ?? t("Type the name to confirm");
  const nameOk = !spec.destructive || nameInput.trim() === spec.destructive.expectedName;
  const reasonOk = !requireReason || reason.trim().length >= 3;
  const canSubmit = !busy && reasonOk && nameOk;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const background = document.getElementById("admin-shell-background");
    const skipLink = document.getElementById("admin-skip-link");
    background?.setAttribute("aria-hidden", "true");
    skipLink?.setAttribute("aria-hidden", "true");
    if (background instanceof HTMLElement) background.inert = true;
    if (skipLink instanceof HTMLElement) skipLink.inert = true;
    const timer = window.setTimeout(() => {
      dialogRef.current?.querySelector<HTMLElement>("input, button:not([disabled])")?.focus();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      background?.removeAttribute("aria-hidden");
      skipLink?.removeAttribute("aria-hidden");
      if (background instanceof HTMLElement) background.inert = false;
      if (skipLink instanceof HTMLElement) skipLink.inert = false;
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    function handleDocumentKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener("keydown", handleDocumentKeyDown);
    return () => document.removeEventListener("keydown", handleDocumentKeyDown);
  }, [busy, onClose]);

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
    ) ?? [])].filter((element) => !element.hasAttribute("hidden"));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await spec.onSubmit(requireReason ? reason.trim() : "");
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : t("Request failed"));
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/20 p-4">
      <div
        aria-describedby={spec.summary ? descriptionId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className="w-full max-w-md rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-6"
        onKeyDown={handleDialogKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <h3 className="text-sm font-semibold text-[var(--ad-ink)]" id={titleId}>{spec.title}</h3>
        {spec.summary ? (
          <div className="mt-2 text-sm text-[var(--ad-text-muted)]" id={descriptionId}>{spec.summary}</div>
        ) : null}
        <div className="mt-4 space-y-3">
          {requireReason ? (
            <input
              aria-label={reasonLabel}
              className={INPUT_CLASS}
              onChange={(event) => setReason(event.target.value)}
              placeholder={reasonLabel}
              value={reason}
            />
          ) : null}
          {spec.destructive ? (
            <input
              aria-label={destructiveInputLabel}
              className={INPUT_CLASS}
              onChange={(event) => setNameInput(event.target.value)}
              placeholder={`${destructiveInputLabel}: ${spec.destructive.expectedName}`}
              value={nameInput}
            />
          ) : null}
          {error ? <p className="text-sm text-[var(--ad-red-text)]" role="alert">{error}</p> : null}
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
    </div>,
    document.body,
  );
}
