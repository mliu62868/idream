"use client";

import { Flag, Loader2, RotateCcw, Search } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiWrite } from "@/components/admin/api";
import {
  ConfirmDialog,
  type ConfirmSpec,
} from "@/components/admin/ui/ConfirmDialog";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { DataTable, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import {
  authorityRequestFailed,
  authorityRequestStarted,
  authorityRequestSucceeded,
  createAuthorityState,
  type AuthorityState,
} from "@/lib/authority-state";
import { createLatestRequestGate } from "@/lib/latest-request";
import {
  contentListPath,
  contentQueryFromSearch,
  contentWorkspaceUrl,
  type ContentQuery,
} from "./query";

type Row = Record<string, unknown>;
type PageInfo = { endCursor: string | null; hasNextPage: boolean };
type CharacterResponse = { items: Row[]; pageInfo: PageInfo };
type FeaturedResponse = { items: Row[]; characterIds: string[] };

export function ContentMerchandisingWorkspace({
  canWrite,
}: {
  canWrite: boolean;
}) {
  const [query, setQuery] = useState<ContentQuery>(() => currentQuery());
  const [draft, setDraft] = useState<ContentQuery>(() => currentQuery());
  const [characters, setCharacters] =
    useState(() => createAuthorityState<CharacterResponse>());
  const [featured, setFeatured] =
    useState(() => createAuthorityState<FeaturedResponse>());
  const [featuredInput, setFeaturedInput] = useState("");
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null);
  const characterGate = useRef(createLatestRequestGate());
  const featuredGate = useRef(createLatestRequestGate());
  const featuredKey = useRef<string | null>(null);
  const initialQuery = useRef(query);

  const loadCharacters = useCallback(async (next: ContentQuery) => {
    const queryKey = contentListPath(next);
    const request = characterGate.current.begin();
    setCharacters((current) => authorityRequestStarted(current, queryKey));
    try {
      const data = await apiGet<CharacterResponse>(queryKey);
      if (!request.isCurrent()) return;
      setCharacters(authorityRequestSucceeded(queryKey, data));
    } catch (cause) {
      if (!request.isCurrent()) return;
      setCharacters((current) => authorityRequestFailed(
        current,
        queryKey,
        errorMessage(cause, "Characters could not be loaded"),
      ));
    }
  }, []);

  const loadFeatured = useCallback(async () => {
    const queryKey = "/api/v1/admin/content/featured";
    const request = featuredGate.current.begin();
    setFeatured((current) => authorityRequestStarted(current, queryKey));
    try {
      const data = await apiGet<FeaturedResponse>(queryKey);
      if (!request.isCurrent()) return;
      setFeatured(authorityRequestSucceeded(queryKey, data));
      setFeaturedInput(data.characterIds.join(", "));
    } catch (cause) {
      if (!request.isCurrent()) return;
      setFeatured((current) => authorityRequestFailed(
        current,
        queryKey,
        errorMessage(cause, "Featured content could not be loaded"),
      ));
    }
  }, []);

  const load = useCallback(
    (next: ContentQuery) => {
      void loadCharacters(next);
      void loadFeatured();
    },
    [loadCharacters, loadFeatured],
  );

  useEffect(() => {
    const currentCharacterGate = characterGate.current;
    const currentFeaturedGate = featuredGate.current;
    const restore = () => {
      const next = currentQuery();
      setQuery(next);
      setDraft(next);
      load(next);
    };
    load(initialQuery.current);
    window.addEventListener("popstate", restore);
    window.addEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, restore);
    return () => {
      currentCharacterGate.invalidate();
      currentFeaturedGate.invalidate();
      window.removeEventListener("popstate", restore);
      window.removeEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, restore);
    };
  }, [load]);

  function navigate(next: ContentQuery) {
    window.history.pushState(
      null,
      "",
      contentWorkspaceUrl(
        window.location.pathname,
        window.location.search,
        next,
      ),
    );
    setQuery(next);
    setDraft(next);
    void loadCharacters(next);
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate({ ...draft, cursor: "" });
  }

  const expectedConfirmation = parseCsv(featuredInput).join(",") || "CLEAR";
  async function saveFeatured() {
    featuredKey.current ??= crypto.randomUUID();
    setSaving(true);
    setSaveError(null);
    try {
      await apiWrite(
        "/api/v1/admin/content/featured",
        "PUT",
        {
          characterIds: parseCsv(featuredInput),
          reason: reason.trim(),
          confirmation: confirmation.trim(),
        },
        { "idempotency-key": featuredKey.current },
      );
      featuredKey.current = null;
      setReason("");
      setConfirmation("");
      await loadFeatured();
    } catch (cause) {
      setSaveError(errorMessage(cause, "Featured content could not be saved"));
    } finally {
      setSaving(false);
    }
  }

  function command(id: string, field: "visibility" | "status", value: string) {
    const expected = `${id}:${field}:${value}`;
    const key = crypto.randomUUID();
    setConfirmSpec({
      title: field === "visibility" ? `Make ${id} private` : `Remove ${id}`,
      destructive: { expectedName: expected, inputLabel: "Type confirmation" },
      submitLabel: field === "visibility" ? "Make private" : "Remove",
      onSubmit: async (commandReason) => {
        await apiWrite(
          `/api/v1/admin/content/characters/${encodeURIComponent(id)}/${field}`,
          "POST",
          { [field]: value, reason: commandReason, confirmation: expected },
          { "idempotency-key": key },
        );
        await loadCharacters(query);
        await loadFeatured();
      },
    });
  }

  const characterRows = (characters.data?.items ?? []).map((row) =>
    characterTableRow(row, canWrite, command),
  );
  const featuredRows = (featured.data?.items ?? []).map(simpleRow);
  return (
    <section className="space-y-5">
      <PageHeader
        purpose="Search the catalog, control visibility and lifecycle state, and curate the public featured feed."
        title="Featured Merchandising"
      />
      <div
        className="flex flex-wrap justify-between gap-3 text-xs text-[var(--ad-text-muted)]"
        role="status"
      >
        <div className="flex gap-3">
          <Freshness authority="Characters" state={characters} />
          <Freshness authority="Featured" state={featured} />
        </div>
        {!canWrite ? (
          <strong>Read only · content.takedown.write is not granted</strong>
        ) : null}
      </div>
      <form
        className="grid gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 md:grid-cols-4"
        onSubmit={apply}
      >
        <Field
          label="Search"
          onChange={(search) => setDraft((value) => ({ ...value, search }))}
          value={draft.search}
        />
        <Select
          label="Status"
          onChange={(status) => setDraft((value) => ({ ...value, status }))}
          options={[
            "",
            "draft",
            "pending_review",
            "approved",
            "rejected",
            "removed",
            "archived",
          ]}
          value={draft.status}
        />
        <Select
          label="Visibility"
          onChange={(visibility) =>
            setDraft((value) => ({ ...value, visibility }))
          }
          options={["", "private", "unlisted", "public"]}
          value={draft.visibility}
        />
        <div className="flex items-end gap-2">
          <button
            className="inline-flex h-11 items-center gap-2 rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white"
            type="submit"
          >
            <Search className="h-4 w-4" />
            Apply
          </button>
          <button
            className="inline-flex h-11 items-center gap-2 rounded-md border border-[var(--ad-border)] px-4 text-sm"
            onClick={() =>
              navigate({ search: "", status: "", visibility: "", cursor: "" })
            }
            type="button"
          >
            <RotateCcw className="h-4 w-4" />
            Reset
          </button>
        </div>
      </form>
      {featured.error ? (
        <AuthorityRequestError
          message={featured.error}
          onRetry={() => void loadFeatured()}
          snapshotAt={featured.data ? featured.refreshedAt : null}
        />
      ) : null}
      {featured.loading && featured.data === null ? (
        <p className="text-sm text-[var(--ad-text-muted)]" role="status">
          Loading featured authority…
        </p>
      ) : null}
      {featured.data ? <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <h2 className="text-sm font-semibold">Featured curation</h2>
        <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
          Only public, approved characters are retained in the public feed.
        </p>
        <div className="mt-3 grid gap-3 md:grid-cols-[1fr_220px_260px_auto]">
          <input
            className="h-10 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 font-mono text-sm"
            disabled={!canWrite}
            onChange={(event) => {
              setFeaturedInput(event.target.value);
              setConfirmation("");
              featuredKey.current = null;
            }}
            placeholder="char_a, char_b"
            value={featuredInput}
          />
          <input
            className="h-10 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm"
            disabled={!canWrite}
            onChange={(event) => {
              setReason(event.target.value);
              featuredKey.current = null;
            }}
            placeholder="Reason (≥3 chars)"
            value={reason}
          />
          <input
            aria-label="Featured confirmation"
            className="h-10 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 font-mono text-sm"
            disabled={!canWrite}
            onChange={(event) => {
              setConfirmation(event.target.value);
              featuredKey.current = null;
            }}
            placeholder={
              expectedConfirmation === "CLEAR"
                ? "Type CLEAR"
                : "Type featured IDs"
            }
            value={confirmation}
          />
          <button
            className="inline-flex h-10 items-center gap-2 bg-[var(--ad-ink)] px-3 text-sm font-semibold text-white disabled:opacity-50"
            disabled={
              !canWrite ||
              saving ||
              reason.trim().length < 3 ||
              confirmation.trim() !== expectedConfirmation
            }
            onClick={() => void saveFeatured()}
            type="button"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Flag className="h-4 w-4" />
            )}
            Save featured
          </button>
        </div>
        {saveError ? (
          <p className="mt-2 text-xs text-[var(--ad-red-text)]" role="alert">
            {saveError}
          </p>
        ) : null}
      </section> : null}
      {featured.data ? <DataTable
        caption="Currently featured"
        empty={<EmptyState title="No featured characters" />}
        headers={["ID", "Name", "Visibility", "Status"]}
        rows={featuredRows}
      /> : null}
      {characters.error ? (
        <AuthorityRequestError
          message={characters.error}
          onRetry={() => void loadCharacters(query)}
          snapshotAt={characters.data ? characters.refreshedAt : null}
        />
      ) : null}
      {characters.loading && characters.data === null ? (
        <p className="text-sm text-[var(--ad-text-muted)]" role="status">
          Loading character authority…
        </p>
      ) : null}
      {characters.data ? <DataTable
        caption="Characters"
        empty={<EmptyState title="No characters match these filters" />}
        headers={[
          "ID",
          "Name",
          "Gender",
          "Style",
          "Visibility",
          "Status",
          "Created",
          "Actions",
        ]}
        rows={characterRows}
      /> : null}
      {characters.data?.pageInfo.hasNextPage &&
      characters.data.pageInfo.endCursor ? (
        <button
          className="inline-flex h-11 items-center gap-2 rounded-md border border-[var(--ad-border)] px-4 text-sm"
          onClick={() =>
            navigate({
              ...query,
              cursor: characters.data?.pageInfo.endCursor ?? "",
            })
          }
          type="button"
        >
          Next page
        </button>
      ) : null}
      {confirmSpec ? (
        <ConfirmDialog
          onClose={() => setConfirmSpec(null)}
          spec={confirmSpec}
        />
      ) : null}
    </section>
  );
}

function Freshness<T>({
  authority,
  state,
}: {
  authority: string;
  state: AuthorityState<T>;
}) {
  if (state.loading) return <span>{authority}: refreshing</span>;
  if (state.error) {
    return (
      <span>
        {authority}: {state.data ? "stale" : "unavailable"} · retry available
      </span>
    );
  }
  return (
    <span>
      {authority}: fresh{" "}
      {state.refreshedAt
        ? new Date(state.refreshedAt).toLocaleTimeString()
        : ""}
    </span>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1 text-xs font-medium text-[var(--ad-text-muted)]">
      {label}
      <input
        className="h-11 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm text-[var(--ad-text)]"
        onChange={(event) => onChange(event.target.value)}
        type="search"
        value={value}
      />
    </label>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1 text-xs font-medium text-[var(--ad-text-muted)]">
      {label}
      <select
        className="h-11 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm text-[var(--ad-text)]"
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

function simpleRow(row: Row): DataTableRow {
  return {
    id: stringValue(row.id),
    cells: [
      cell(row.id),
      cell(row.name),
      cell(row.visibility),
      cell(row.status),
    ],
  };
}

function characterTableRow(
  row: Row,
  canWrite: boolean,
  command: (id: string, field: "visibility" | "status", value: string) => void,
): DataTableRow {
  const id = stringValue(row.id);
  const actions: ReactNode = (
    <div className="flex gap-2">
      <button
        className="rounded border border-[var(--ad-border)] px-2 py-1 text-xs disabled:opacity-50"
        disabled={!canWrite}
        onClick={() => command(id, "visibility", "private")}
        type="button"
      >
        Make private
      </button>
      <button
        className="rounded border border-[var(--ad-border)] px-2 py-1 text-xs disabled:opacity-50"
        disabled={!canWrite}
        onClick={() => command(id, "status", "removed")}
        type="button"
      >
        Remove
      </button>
    </div>
  );
  return {
    id,
    cells: [
      cell(row.id),
      cell(row.name),
      cell(row.gender),
      cell(row.style),
      cell(row.visibility),
      cell(row.status),
      cell(row.createdAt),
      actions,
    ],
  };
}

function cell(value: unknown) {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  return JSON.stringify(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function parseCsv(value: string) {
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function currentQuery() {
  return typeof window === "undefined"
    ? contentQueryFromSearch("")
    : contentQueryFromSearch(window.location.search);
}

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}
