"use client";

// SPEC: 工作区头部一键「复制为新草稿」：无确认框，成功后直接打开新角色。
// INTENT: 复制只新建私有草稿，源角色和线上都不变，因此不需要确认。
import { Copy, Loader2 } from "lucide-react";
import { useState } from "react";
import { useAdminI18n } from "@/components/admin/i18n";
import { operatorErrorCopy } from "@/components/admin/ui/request-error-copy";
import { RequestErrorDetails } from "@/components/admin/ui/RequestErrorDetails";
import { WorkspaceButton } from "@/features/operations/WorkspaceUi";
import { adminV2Operation } from "@/lib/admin-v2-operation";

export function CharacterDuplicateButton({ characterId }: { characterId: string }) {
  const { t } = useAdminI18n();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  async function duplicate() {
    setBusy(true);
    setFailure(null);
    try {
      const created = await adminV2Operation("POST /api/v2/admin/characters/:id/duplicate", {
        path: { id: characterId },
        body: {},
      });
      window.location.assign(created.deepLink);
    } catch (cause) {
      setFailure(cause);
      setBusy(false);
    }
  }

  const copy = failure ? operatorErrorCopy(failure) : null;
  return (
    <div className="flex flex-col gap-1 lg:items-end">
      <WorkspaceButton disabled={busy} onClick={() => void duplicate()}>
        {busy ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : <Copy aria-hidden="true" className="h-4 w-4" />}
        {t(busy ? "Copying…" : "Copy as new draft")}
      </WorkspaceButton>
      {copy ? (
        <div className="max-w-sm rounded-md bg-[var(--ad-red-bg)] p-2 text-xs text-[var(--ad-red-text)]" role="alert">
          <p className="font-semibold">{t(copy.headline)}</p>
          <p className="mt-1">{t(copy.nextStep, copy.nextStepValues)}</p>
          <RequestErrorDetails technical={copy.technical} />
        </div>
      ) : null}
    </div>
  );
}
