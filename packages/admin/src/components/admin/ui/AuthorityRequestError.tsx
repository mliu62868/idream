"use client";

import { RefreshCcw } from "lucide-react";

export function AuthorityRequestError({
  message,
  onRetry,
  snapshotAt,
}: {
  message: string;
  onRetry: () => void;
  snapshotAt?: string | null;
}) {
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-md bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]"
      role="alert"
    >
      <span>
        <span className="block">{message}</span>
        {snapshotAt ? (
          <span className="mt-1 block text-xs">
            Showing the last successful snapshot from{" "}
            <time dateTime={snapshotAt}>{formatSnapshotTime(snapshotAt)}</time>.
          </span>
        ) : null}
      </span>
      <button
        className="inline-flex min-h-9 shrink-0 items-center gap-2 rounded border border-current px-3 font-semibold"
        onClick={onRetry}
        type="button"
      >
        <RefreshCcw className="h-4 w-4" />
        Retry
      </button>
    </div>
  );
}

function formatSnapshotTime(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}
