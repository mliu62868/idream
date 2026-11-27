"use client";

// SPEC: 工作区头部一键「复制为新草稿」：无确认框，成功后直接打开新角色，并在新角色页上一次性说明复制结果。
// INTENT: 复制只新建私有草稿，源角色和线上都不变，因此不需要确认。
import type { CharacterProjectDuplicateResponse } from "@idream/shared/admin";
import { Copy, Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useAdminI18n } from "@/components/admin/i18n";
import { operatorErrorCopy } from "@/components/admin/ui/request-error-copy";
import { RequestErrorDetails } from "@/components/admin/ui/RequestErrorDetails";
import { WorkspaceButton } from "@/features/operations/WorkspaceUi";
import { AdminV2RequestError } from "@/lib/admin-v2-api";
import { adminV2Operation } from "@/lib/admin-v2-operation";

type DuplicateReceipt = Pick<
  CharacterProjectDuplicateResponse,
  "copiedImageCount" | "skippedImageCount" | "identityCopied"
>;

// INVARIANT: 回执只活一次——按新角色 id 存在本标签页的 sessionStorage，新角色页读到即删，刷新不会再弹。
//            不放进 URL：分享或收藏链接不该带着一次性的提示。
const RECEIPT_KEY_PREFIX = "idream.admin.character-duplicate-receipt.v1:";

function saveDuplicateReceipt(characterId: string, receipt: DuplicateReceipt) {
  try {
    window.sessionStorage.setItem(`${RECEIPT_KEY_PREFIX}${characterId}`, JSON.stringify(receipt));
  } catch {
    // Without storage the copy still opens; only the one-time summary is lost.
  }
}

function takeDuplicateReceipt(characterId: string): DuplicateReceipt | null {
  try {
    const key = `${RECEIPT_KEY_PREFIX}${characterId}`;
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    window.sessionStorage.removeItem(key);
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const { copiedImageCount, skippedImageCount, identityCopied } = value as Record<string, unknown>;
    if (typeof copiedImageCount !== "number" || typeof skippedImageCount !== "number" || typeof identityCopied !== "boolean") return null;
    return { copiedImageCount, skippedImageCount, identityCopied };
  } catch {
    return null;
  }
}

function missingTraitsLink(failure: unknown): string | null {
  if (!(failure instanceof AdminV2RequestError) || failure.status !== 409) return null;
  const details = failure.details as { reason?: unknown; deepLink?: unknown } | undefined;
  return details?.reason === "visual_traits_missing" && typeof details.deepLink === "string" ? details.deepLink : null;
}

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
      saveDuplicateReceipt(created.characterId, {
        copiedImageCount: created.copiedImageCount,
        skippedImageCount: created.skippedImageCount,
        identityCopied: created.identityCopied,
      });
      window.location.assign(created.deepLink);
    } catch (cause) {
      setFailure(cause);
      setBusy(false);
    }
  }

  const traitsLink = missingTraitsLink(failure);
  const copy = failure && !traitsLink ? operatorErrorCopy(failure) : null;
  return (
    <div className="flex flex-col gap-1 lg:items-end">
      <WorkspaceButton disabled={busy} onClick={() => void duplicate()}>
        {busy ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : <Copy aria-hidden="true" className="h-4 w-4" />}
        {t(busy ? "Copying…" : "Copy as new draft")}
      </WorkspaceButton>
      {traitsLink ? (
        <div className="max-w-sm rounded-md bg-[var(--ad-red-bg)] p-2 text-xs text-[var(--ad-red-text)]" role="alert">
          <p className="font-semibold">{t("This character has no features that never change, so it cannot be copied yet.")}</p>
          <p className="mt-1">{t("Add at least one in its settings, then copy again.")}</p>
          <Link className="mt-1 inline-flex min-h-11 items-center font-medium underline underline-offset-4" href={traitsLink}>
            {t("Open character settings")}
          </Link>
        </div>
      ) : null}
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

// SPEC: 新草稿页顶部的一次性复制回执：拷了几张图、身份是否带上、哪些需要重新选。
export function CharacterDuplicateReceipt({ characterId }: { characterId: string }) {
  const { t } = useAdminI18n();
  const [receipt, setReceipt] = useState<DuplicateReceipt | null>(null);

  // WHY(setTimeout 0): sessionStorage 只在挂载后可读；与本仓既有做法一致，把读取推出 effect 的同步阶段，
  // 避免 react-hooks/set-state-in-effect 的级联渲染。清理时取消计时器，严格模式重挂载也只取一次。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const taken = takeDuplicateReceipt(characterId);
      if (taken) setReceipt(taken);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [characterId]);

  if (!receipt) return null;
  return (
    <div
      className="mt-4 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-green-bg)] p-3 text-sm text-[var(--ad-green-text)]"
      data-testid="character-duplicate-receipt"
      role="status"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{t("Copied as a new private draft.")}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            <li>{t("Images copied: {count}.", { count: String(receipt.copiedImageCount) })}</li>
            {receipt.skippedImageCount > 0 ? (
              <li>{t("Images that could not be copied and were left out: {count}.", { count: String(receipt.skippedImageCount) })}</li>
            ) : null}
            <li>{t(receipt.identityCopied
              ? "The visual identity came along with its reference images."
              : "The visual identity was not copied. Set it up again on the Appearance & identity tab.")}</li>
            <li>{t("Choose the primary portrait, character hero and chat moment images again; draft selections are not copied.")}</li>
          </ul>
        </div>
        <WorkspaceButton onClick={() => setReceipt(null)}>{t("Dismiss")}</WorkspaceButton>
      </div>
    </div>
  );
}
