"use client";

// SPEC: 角色审核队列面板 —— 自取数列出待审（pending）角色提交，逐行 Approve/Reject。
// INTENT: 决策弹窗收集 reviewReason(可选) + reason(必填) + confirmation("REVIEW")，复用 safety.review.* 权限。
// INVARIANTS: 仅展示后端返回的 pending 项；决策成功后刷新队列；confirmation 必须等于 REVIEW 才允许提交。
import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, X } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { cn } from "@/lib/utils";

type ReviewCharacter = {
  id: string;
  name: string;
  gender: string;
  style: string;
  visibility: string;
  status: string;
  description: string;
  createdAt: string;
};

type ReviewItem = {
  submissionId: string;
  submittedAt: string;
  character: ReviewCharacter;
  reportCount: number;
};

type Decision = "approve" | "reject";

type PendingDecision = {
  item: ReviewItem;
  decision: Decision;
};

const CONFIRM_TOKEN = "REVIEW";

export function ReviewQueueView() {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingDecision | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ items: ReviewItem[] }>("/api/v1/admin/content/review-queue");
      setItems(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <div className="space-y-4">
      <p className="text-xs text-[rgb(170,170,170)]">
        角色人审队列：仅展示 status=pending 的提交。Approve 将角色置为 approved，Reject 置为 rejected，均需理由并审计。
      </p>

      {error ? <p className="text-xs text-red-300">{error}</p> : null}

      <section className="overflow-hidden border border-white/10 bg-[rgb(18,18,18)]">
        <div className="flex h-11 items-center justify-between border-b border-white/10 px-4">
          <h2 className="text-sm font-semibold">Pending submissions</h2>
          <span className="text-xs text-[rgb(170,170,170)]">{items.length}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] border-collapse text-left text-sm">
            <thead className="bg-black/20 text-[11px] uppercase text-[rgb(170,170,170)]">
              <tr>
                {["name", "gender", "style", "description", "reports", "submittedAt"].map((column) => (
                  <th key={column} className="border-b border-white/10 px-3 py-2 font-semibold">
                    {column}
                  </th>
                ))}
                <th className="border-b border-white/10 px-3 py-2 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.submissionId} className="border-b border-white/5 last:border-0">
                  <td className="px-3 py-2 align-top text-[rgb(230,230,230)]">{item.character.name}</td>
                  <td className="px-3 py-2 align-top text-[rgb(230,230,230)]">{item.character.gender}</td>
                  <td className="px-3 py-2 align-top text-[rgb(230,230,230)]">{item.character.style}</td>
                  <td className="max-w-[260px] px-3 py-2 align-top text-[rgb(230,230,230)]">
                    {truncate(item.character.description, 120)}
                  </td>
                  <td className="px-3 py-2 align-top text-[rgb(230,230,230)]">
                    <span className={cn(item.reportCount > 0 && "text-amber-300")}>{item.reportCount}</span>
                  </td>
                  <td className="px-3 py-2 align-top text-[rgb(170,170,170)]">{formatDate(item.submittedAt)}</td>
                  <td className="px-3 py-2 align-top">
                    <div className="flex gap-1">
                      <IconAction
                        icon={<Check className="h-4 w-4" />}
                        label="Approve"
                        onClick={() => setPending({ item, decision: "approve" })}
                      />
                      <IconAction
                        icon={<X className="h-4 w-4" />}
                        label="Reject"
                        onClick={() => setPending({ item, decision: "reject" })}
                      />
                    </div>
                  </td>
                </tr>
              ))}
              {items.length === 0 ? (
                <tr>
                  <td className="px-3 py-8 text-center text-sm text-[rgb(170,170,170)]" colSpan={7}>
                    {loading ? "Loading…" : "Empty"}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {pending ? (
        <DecisionDialog
          pending={pending}
          onClose={() => setPending(null)}
          onDone={async () => {
            setPending(null);
            await load();
          }}
        />
      ) : null}
    </div>
  );
}

function DecisionDialog({
  pending,
  onClose,
  onDone,
}: {
  pending: PendingDecision;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { item, decision } = pending;
  const [reviewReason, setReviewReason] = useState("");
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = reason.trim().length >= 3 && confirmation === CONFIRM_TOKEN && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await apiWrite(
        `/api/v1/admin/content/review-queue/${item.submissionId}/decision`,
        "POST",
        {
          decision,
          reviewReason: reviewReason.trim() || undefined,
          reason: reason.trim(),
          confirmation,
        },
      );
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Decision failed");
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md border border-white/10 bg-[rgb(18,18,18)] p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="text-sm font-semibold">
          {decision === "approve" ? "Approve" : "Reject"} {item.character.name}
        </h3>
        <p className="mt-1 text-xs text-[rgb(170,170,170)]">
          确认提交后角色将被置为 {decision === "approve" ? "approved" : "rejected"}。
        </p>
        <div className="mt-4 space-y-3">
          <textarea
            className="min-h-16 w-full border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-white/30"
            onChange={(event) => setReviewReason(event.target.value)}
            placeholder="Review note (optional, shown to creator)"
            value={reviewReason}
          />
          <input
            className="h-10 w-full border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-white/30"
            onChange={(event) => setReason(event.target.value)}
            placeholder="Audit reason (≥3)"
            value={reason}
          />
          <input
            className="h-10 w-full border border-white/10 bg-black/30 px-3 font-mono text-sm outline-none focus:border-white/30"
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder={`Type ${CONFIRM_TOKEN} to confirm`}
            value={confirmation}
          />
          {error ? <p className="text-xs text-red-300">{error}</p> : null}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            className="inline-flex h-10 items-center border border-white/10 px-3 text-sm text-[rgb(230,230,230)]"
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
          <button
            className="inline-flex h-10 items-center gap-2 bg-white px-3 text-sm font-semibold text-black disabled:opacity-50"
            disabled={!canSubmit}
            onClick={() => void submit()}
            type="button"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

function IconAction({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className="inline-flex h-8 items-center gap-1 border border-white/10 px-2 text-xs text-[rgb(230,230,230)] hover:border-white/30"
      onClick={onClick}
      title={label}
      type="button"
    >
      {icon}
      {label}
    </button>
  );
}

function truncate(value: string, max: number) {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
