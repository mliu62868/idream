"use client";

import {
  ADMIN_DATA_CLASSES,
  accessUserListResponseSchema,
  type AccessUserListItem,
  type AccessUserListResponse,
} from "@idream/shared/admin";
import { ADMIN_PERMISSION_KEYS } from "@idream/shared/admin/permissions";
import type { FormEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Ban, Check, Loader2, RefreshCcw, ShieldCheck, X } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import {
  ConfirmDialog,
  type ConfirmSpec,
} from "@/components/admin/ui/ConfirmDialog";
import { DataTable, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { createLatestRequestGate } from "@/lib/latest-request";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import {
  accessListPath,
  accessPermissionConfirmation,
  accessQueryFromSearch,
  accessStatusConfirmation,
  accessWorkspaceUrl,
  defaultAccessQuery,
  type AccessDataClassFilter,
  type AccessQuery,
} from "./query";

type PermissionDraft = {
  userId: string;
  permissionKey: string;
  effect: "grant" | "revoke" | "clear";
};
const emptyPermission: PermissionDraft = {
  userId: "",
  permissionKey: "billing.ledger.adjust",
  effect: "grant",
};

export function AccessWorkspace({
  permissions,
}: {
  permissions: { changeStatus: boolean; managePermissions: boolean };
}) {
  const [query, setQuery] = useState<AccessQuery>(() => currentQuery());
  const [draft, setDraft] = useState<AccessQuery>(() => currentQuery());
  const [data, setData] = useState<AccessUserListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [permissionDraft, setPermissionDraft] = useState(emptyPermission);
  const [confirmation, setConfirmation] = useState<ConfirmSpec | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const gate = useRef(createLatestRequestGate());
  const initialQuery = useRef(query);

  const load = useCallback(async (next: AccessQuery) => {
    const request = gate.current.begin();
    setLoading(true);
    setError(null);
    try {
      const response = accessUserListResponseSchema.parse(
        await apiGet<unknown>(accessListPath(next)),
      );
      if (!request.isCurrent()) return;
      setData(response);
      setRefreshedAt(new Date().toISOString());
    } catch (cause) {
      if (request.isCurrent())
        setError(
          cause instanceof Error
            ? cause.message
            : "Access authority request failed",
        );
    } finally {
      if (request.isCurrent()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const requestGate = gate.current;
    void load(initialQuery.current);
    const restore = () => {
      const next = currentQuery();
      setQuery(next);
      setDraft(next);
      void load(next);
    };
    window.addEventListener("popstate", restore);
    window.addEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, restore);
    return () => {
      requestGate.invalidate();
      window.removeEventListener("popstate", restore);
      window.removeEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, restore);
    };
  }, [load]);

  function navigate(next: AccessQuery, mode: "push" | "replace" = "push") {
    window.history[mode === "push" ? "pushState" : "replaceState"](
      null,
      "",
      accessWorkspaceUrl(
        window.location.pathname,
        window.location.search,
        next,
      ),
    );
    setQuery(next);
    setDraft(next);
    void load(next);
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate({ ...draft, cursor: "" });
  }

  function confirmCommand(input: {
    title: string;
    endpoint: string;
    expected: string;
    payload: (reason: string) => Record<string, unknown>;
  }) {
    const idempotencyKey = crypto.randomUUID();
    setConfirmation({
      title: input.title,
      destructive: { expectedName: input.expected, inputLabel: "Confirmation" },
      reasonLabel: "Reason",
      submitLabel: "Confirm",
      onSubmit: async (reason) => {
        await apiWrite(
          input.endpoint,
          "POST",
          { ...input.payload(reason), confirmation: input.expected },
          { "idempotency-key": idempotencyKey },
        );
        setNotice(`${input.title} completed.`);
        navigate({ ...query, cursor: "" }, "replace");
      },
    });
  }

  const users = data?.items ?? [];
  const filtered = Boolean(
    query.search || query.role || query.status || query.dataClass,
  );
  return (
    <section className="space-y-5">
      <PageHeader
        purpose="Search the complete user authority, apply narrowly scoped permission overrides, and suspend or restore access through audited commands."
        title="Team Access"
      />
      <div
        className="flex flex-wrap justify-between gap-2 text-xs text-[var(--ad-text-muted)]"
        role="status"
      >
        <span>
          Legacy compatibility authority · source freshness watermark
          unavailable · {freshness(data, loading, error, refreshedAt)}
        </span>
        <span className="flex gap-3 font-semibold">
          {!permissions.managePermissions ? (
            <span>
              Permission override unavailable · user.role.write is not granted
            </span>
          ) : null}
          {!permissions.changeStatus ? (
            <span>
              Status change unavailable · user.status.write is not granted
            </span>
          ) : null}
        </span>
      </div>
      <form
        className="grid gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 md:grid-cols-2 xl:grid-cols-[minmax(240px,1fr)_160px_160px_160px_auto]"
        onSubmit={apply}
      >
        <Field
          label="Search users"
          onChange={(search) => setDraft((value) => ({ ...value, search }))}
          search
          value={draft.search}
        />
        <Select
          label="Role"
          onChange={(role) => setDraft((value) => ({ ...value, role }))}
          options={[
            "",
            "user",
            "moderator",
            "support",
            "ops",
            "analyst",
            "admin",
          ]}
          value={draft.role}
        />
        <Select
          label="Status"
          onChange={(status) => setDraft((value) => ({ ...value, status }))}
          options={["", "active", "suspended", "deleted"]}
          value={draft.status}
        />
        <Select
          label="Data class"
          onChange={(dataClass) =>
            setDraft((value) => ({
              ...value,
              dataClass: dataClass as AccessDataClassFilter,
            }))
          }
          options={["", ...ADMIN_DATA_CLASSES]}
          value={draft.dataClass}
        />
        <div className="flex items-end gap-2">
          <button
            className="min-h-11 rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white"
            type="submit"
          >
            Filter users
          </button>
          {filtered ? (
            <button
              aria-label="Clear access filters"
              className="grid min-h-11 min-w-11 place-items-center rounded-md border border-[var(--ad-border)]"
              onClick={() => navigate(defaultAccessQuery)}
              type="button"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </form>
      {permissions.managePermissions ? (
        <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
          <h3 className="font-semibold">Permission override</h3>
          <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
            Grant, revoke, or clear one effective permission without changing
            the user role.
          </p>
          <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_140px_auto]">
            <Field
              label="Permission user ID"
              onChange={(userId) =>
                setPermissionDraft((value) => ({ ...value, userId }))
              }
              value={permissionDraft.userId}
            />
            <Select
              label="Permission key"
              onChange={(permissionKey) =>
                setPermissionDraft((value) => ({ ...value, permissionKey }))
              }
              options={[...ADMIN_PERMISSION_KEYS]}
              value={permissionDraft.permissionKey}
            />
            <Select
              label="Permission effect"
              onChange={(effect) =>
                setPermissionDraft((value) => ({
                  ...value,
                  effect: effect as PermissionDraft["effect"],
                }))
              }
              options={["grant", "revoke", "clear"]}
              value={permissionDraft.effect}
            />
            <button
              className="inline-flex min-h-11 items-center justify-center gap-2 self-end bg-[var(--ad-ink)] px-3 text-sm font-semibold text-white disabled:opacity-50"
              disabled={!permissionDraft.userId.trim()}
              onClick={() => {
                const userId = permissionDraft.userId.trim();
                confirmCommand({
                  title: `${permissionDraft.effect} ${permissionDraft.permissionKey}`,
                  endpoint: `/api/v1/admin/users/${userId}/permissions`,
                  expected: accessPermissionConfirmation(
                    userId,
                    permissionDraft.permissionKey,
                    permissionDraft.effect,
                  ),
                  payload: (reason) => ({
                    permissionKey: permissionDraft.permissionKey,
                    effect: permissionDraft.effect,
                    reason,
                  }),
                });
              }}
              type="button"
            >
              <ShieldCheck className="h-4 w-4" />
              Apply
            </button>
          </div>
        </section>
      ) : null}
      {notice ? (
        <p
          aria-live="polite"
          className="rounded-md bg-[var(--ad-green-bg)] p-3 text-sm text-[var(--ad-green-text)]"
          data-testid="admin-action-status"
          role="status"
        >
          {notice}
        </p>
      ) : null}
      {error ? (
        <div
          className="rounded-md bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]"
          role="alert"
        >
          Access authority refresh failed: {error}
          <button
            className="ml-3 min-h-8 rounded border border-current px-2"
            onClick={() => void load(query)}
            type="button"
          >
            Retry access
          </button>
          {data ? (
            <span className="ml-2">
              The last good snapshot remains visible.
            </span>
          ) : null}
        </div>
      ) : null}
      {!data && loading ? (
        <div
          aria-label="Loading access authority"
          className="rounded-lg border border-[var(--ad-border)] p-4"
          role="status"
        >
          <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
          Loading access authority
        </div>
      ) : data ? (
        users.length === 0 ? (
          <EmptyState
            action={
              filtered ? (
                <button
                  className="min-h-11 rounded-md border px-4"
                  onClick={() => navigate(defaultAccessQuery)}
                  type="button"
                >
                  Clear filters
                </button>
              ) : undefined
            }
            hint={
              filtered
                ? "The complete access authority query returned no matches."
                : "No users exist in the authority."
            }
            title={filtered ? "No users match these filters" : "No users"}
          />
        ) : (
          <DataTable
            caption="Users"
            headers={[
              "ID",
              "Email",
              "Display name",
              "Role",
              "Status",
              "Data class",
              "Dreamcoins",
              "Created",
              "Actions",
            ]}
            rows={userTableRows(
              users,
              permissions.changeStatus,
              confirmCommand,
            )}
          />
        )
      ) : null}
      {data?.pageInfo?.hasNextPage && data.pageInfo.endCursor ? (
        <button
          className="inline-flex min-h-11 items-center gap-2 rounded-md border px-4 text-sm font-semibold"
          disabled={loading}
          onClick={() =>
            navigate({ ...query, cursor: data.pageInfo?.endCursor ?? "" })
          }
          type="button"
        >
          <RefreshCcw className="h-4 w-4" />
          Next user page
        </button>
      ) : null}
      {confirmation ? (
        <ConfirmDialog
          onClose={() => setConfirmation(null)}
          spec={confirmation}
        />
      ) : null}
    </section>
  );
}

function userTableRows(
  users: readonly AccessUserListItem[],
  canChangeStatus: boolean,
  confirm: (input: {
    title: string;
    endpoint: string;
    expected: string;
    payload: (reason: string) => Record<string, unknown>;
  }) => void,
): DataTableRow[] {
  return users.map((user, index) => {
    const id = text(user.id);
    const status = text(user.status);
    const next = status === "suspended" ? "active" : "suspended";
    return {
      id: id || `user-${index}`,
      cells: [
        id,
        display(user.email),
        display(user.displayName),
        display(user.role),
        display(user.status),
        display(user.dataClass),
        display(user.dreamcoins),
        date(user.createdAt),
        canChangeStatus ? (
          <button
            aria-label={next === "active" ? "Restore" : "Suspend"}
            className="inline-flex min-h-9 items-center gap-1 rounded border px-2"
            onClick={() =>
              confirm({
                title: `${next === "active" ? "Restore" : "Suspend"} ${id}`,
                endpoint: `/api/v1/admin/users/${id}/status`,
                expected: accessStatusConfirmation(id, next),
                payload: (reason) => ({ status: next, reason }),
              })
            }
            type="button"
          >
            {next === "active" ? (
              <Check className="h-4 w-4" />
            ) : (
              <Ban className="h-4 w-4" />
            )}
            {next === "active" ? "Restore" : "Suspend"}
          </button>
        ) : (
          "Read only"
        ),
      ],
    };
  });
}
function currentQuery() {
  return typeof window === "undefined"
    ? defaultAccessQuery
    : accessQueryFromSearch(window.location.search);
}
function freshness(
  data: AccessUserListResponse | null,
  loading: boolean,
  error: string | null,
  refreshedAt: string | null,
) {
  const time = refreshedAt
    ? new Date(refreshedAt).toLocaleTimeString()
    : "unknown";
  if (loading && data) return `refreshing · showing snapshot from ${time}`;
  if (error && data) return `stale · last good ${time}`;
  if (error) return "unavailable";
  if (data) return `current client snapshot · ${time}`;
  return "refreshing · no snapshot yet";
}
function Field({
  label,
  onChange,
  search = false,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  search?: boolean;
  value: string;
}) {
  return (
    <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">
      {label}
      <input
        className="min-h-11 rounded-md border bg-[var(--ad-surface)] px-3 text-sm"
        onChange={(event) => onChange(event.target.value)}
        role={search ? "searchbox" : undefined}
        value={value}
      />
    </label>
  );
}
function Select({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: string[];
  value: string;
}) {
  return (
    <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">
      {label}
      <select
        className="min-h-11 rounded-md border bg-[var(--ad-surface)] px-3 text-sm"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {options.map((option) => (
          <option key={option || "all"} value={option}>
            {option || "All"}
          </option>
        ))}
      </select>
    </label>
  );
}
function text(value: unknown) {
  return typeof value === "string" ? value : "";
}
function display(value: unknown) {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "—";
}
function date(value: unknown) {
  const parsed = new Date(text(value));
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString();
}
