"use client";

import { AdminText, useAdminI18n } from "@/components/admin/i18n";
import {
  ADMIN_DATA_CLASSES,
  accessUserListResponseSchema,
  accessUserPermissionListSchema,
  adminGrantBundleListSchema,
  type AccessPermissionOverride,
  type AccessUserListItem,
  type AccessUserListResponse,
  type AdminGrantBundle,
} from "@idream/shared/admin";
import {
  ADMIN_GRANT_BUNDLES,
  ADMIN_PERMISSION_KEYS,
  type AdminGrantBundleKey,
  type AdminPermissionKey,
} from "@idream/shared/admin/permissions";
import { useCallback, useEffect, useRef, useState } from "react";
import { Ban, Check, Loader2, ShieldCheck, UserCog, X } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import {
  ConfirmDialog,
  type ConfirmSpec,
} from "@/components/admin/ui/ConfirmDialog";
import { DataTable, type DataTableRow } from "@/components/admin/ui/DataTable";
import { CopyableId } from "@/components/admin/ui/CopyableId";
import { FilterBar } from "@/components/admin/ui/FilterBar";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { useAdminFormat, text } from "@/components/admin/ui/format";
import { Pagination } from "@/components/admin/ui/Pagination";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { PermissionNotice } from "@/components/admin/ui/PermissionNotice";
import { permissionLabel } from "@/components/admin/ui/permission-copy";
import { useToast } from "@/components/admin/ui/Toast";
import { createLatestRequestGate } from "@/lib/latest-request";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import {
  ACCESS_PAGE_SIZE,
  accessListPath,
  accessBundleConfirmation,
  accessPermissionConfirmation,
  accessQueryFromSearch,
  accessRoleConfirmation,
  accessStatusConfirmation,
  accessWorkspaceUrl,
  defaultAccessQuery,
  type AccessDataClassFilter,
  type AccessQuery,
} from "./query";

type PermissionDraft = {
  userId: string;
  permissionKey: AdminPermissionKey;
  effect: "grant" | "revoke" | "clear";
};
/**
 * SPEC: 目标用户当前的角色、生效权限集合与已有覆盖。
 * INTENT: `GET /users/:id/permissions` 一直都在（api-manifest 里和写命令同一个 user.role.write
 *         门槛），但这个台面从来没查过它。管理员点「授予」之前看不到这个人现在有什么，
 *         也就分不清自己是在补一个缺口，还是在给一个已经有的能力再盖一层覆盖。
 */
type PermissionAuthority = {
  role: string;
  overrides: readonly AccessPermissionOverride[];
  effective: readonly string[];
};
type PermissionLookup = {
  /** 这份结果属于哪个用户 ID —— 输入框还在变的时候，用它判断结果是不是已经过期。 */
  userId: string;
  data: PermissionAuthority | null;
  failed: boolean;
};
const emptyPermission: PermissionDraft = {
  userId: "",
  permissionKey: "billing.ledger.adjust",
  effect: "grant",
};

type AccessUserRole = AccessUserListItem["role"];

// SPEC: 角色清单**双向**钉在契约上 —— 多写一个不存在的角色，或漏掉一个新角色，都是编译错误。
// INTENT: 单靠 `satisfies readonly AccessUserRole[]` 只挡住前一半：契约新增角色时子集依然
//         合法，界面会静默少一个选项，而少的那个恰恰是没人想得起来去补的。第二个参数在
//         "还有没列出的角色"时变成必填，于是漏一个就报 "Expected 2 arguments, but got 1"。
function everyAccessRole<const T extends readonly AccessUserRole[]>(
  roles: T,
  ...missing: Exclude<AccessUserRole, T[number]> extends never
    ? []
    : [unlisted: Exclude<AccessUserRole, T[number]>]
) {
  // 编译通过时 missing 恒为空元组；并进结果只是为了别留一个「定义了却没用」的死参数。
  return [...roles, ...missing];
}

// INTENT: 这个清单原来内联在筛选器的 options 里；再抄一份给角色变更，两处就会各自漂移。
const ACCESS_ROLES = everyAccessRole([
  "user", "moderator", "support", "ops", "analyst", "admin",
]);

/** 运行时从共享的授权包定义推出来，不另抄一份 key 列表。 */
const ADMIN_GRANT_BUNDLE_KEYS = Object.keys(ADMIN_GRANT_BUNDLES) as AdminGrantBundleKey[];

// SPEC: 需要角色范围的授权包，授予时必须带上 characterIds。
// INTENT: 服务端 `permissions/grant-bundles.ts:assertBundleScope` 对 character_producer
//         强制要求非空 scope，其余包则拒绝 scope。这个包又恰好是对象字面量里的第一个，
//         于是"下拉框默认值"就是唯一一个必定 400 的选项 —— 不带范围输入框，它永远授不出去。
// INVARIANT: 判据取自共享定义的 scopes，不再抄一份包名：往 ADMIN_GRANT_BUNDLES 里新增一个
//            带 scope 的包时，输入框自己会跟着出现。
function bundleNeedsCharacterScope(bundleKey: AdminGrantBundleKey) {
  return Object.keys(ADMIN_GRANT_BUNDLES[bundleKey].scopes).length > 0;
}

/** 逗号 / 空白分隔的角色 ID —— 服务端收的是数组，这里只负责切开与去空。 */
function parseCharacterIds(raw: string) {
  return raw.split(/[\s,]+/).filter(Boolean);
}

type BundleLookupData = {
  user: { id: string; role: string; status: string };
  items: readonly AdminGrantBundle[];
};

type BundleLookup = {
  userId: string;
  data: BundleLookupData | null;
  failed: boolean;
};

type AccessCommand = {
  title: string;
  /** 成功后 toast 的正文，调用处已经翻译好。 */
  completed: string;
  endpoint: string;
  /** 撤销授权包是带 body 的 DELETE；其余写命令都是 POST，所以这里可省。 */
  method?: "POST" | "DELETE";
  expected: string;
  consequence: { effect: string; reversible: boolean };
  payload: (reason: string) => Record<string, unknown>;
};

export function AccessWorkspace({
  permissions,
}: {
  permissions: { changeStatus: boolean; managePermissions: boolean };
}) {
  const { t, value: valueLabel } = useAdminI18n();
  const format = useAdminFormat();
  const { toast } = useToast();
  const [query, setQuery] = useState<AccessQuery>(defaultAccessQuery);
  const [draft, setDraft] = useState<AccessQuery>(defaultAccessQuery);
  const [data, setData] = useState<AccessUserListResponse | null>(null);
  // 游标轨迹保留上一页；只有从首页空游标起算时，轨迹长度才能证明页码。
  const [cursorTrail, setCursorTrail] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCause, setErrorCause] = useState<unknown>(undefined);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [permissionDraft, setPermissionDraft] = useState(emptyPermission);
  const [selectedUser, setSelectedUser] = useState<AccessUserListItem | null>(null);
  const [permissionLookup, setPermissionLookup] = useState<PermissionLookup | null>(null);
  const [bundleLookup, setBundleLookup] = useState<BundleLookup | null>(null);
  const [roleChoice, setRoleChoice] = useState<AccessUserRole>("support");
  const [bundleChoice, setBundleChoice] = useState<AdminGrantBundleKey>(ADMIN_GRANT_BUNDLE_KEYS[0]);
  const [bundleCharacterIds, setBundleCharacterIds] = useState("");
  // INVARIANT: 写命令和手动刷新都重新读取权限与授权包，不能用旧权限证明操作结果。
  const [accessRevision, setAccessRevision] = useState(0);
  const [confirmation, setConfirmation] = useState<ConfirmSpec | null>(null);
  const gate = useRef(createLatestRequestGate());
  const permissionGate = useRef(createLatestRequestGate());
  const bundleGate = useRef(createLatestRequestGate());
  const targetField = useRef<HTMLElement>(null);
  const targetUserId = permissionDraft.userId.trim();
  const needsCharacterScope = bundleNeedsCharacterScope(bundleChoice);
  const scopedCharacterIds = parseCharacterIds(bundleCharacterIds);

  const refreshTarget = useCallback(() => {
    permissionGate.current.invalidate();
    bundleGate.current.invalidate();
    setPermissionLookup(null);
    setBundleLookup(null);
    setAccessRevision((value) => value + 1);
  }, []);

  const load = useCallback(async (next: AccessQuery) => {
    const request = gate.current.begin();
    setLoading(true);
    setError(null);
    setErrorCause(undefined);
    try {
      const response = accessUserListResponseSchema.parse(
        await apiGet<unknown>(accessListPath(next)),
      );
      if (!request.isCurrent()) return;
      setData(response);
      setRefreshedAt(new Date().toISOString());
    } catch (cause) {
      if (request.isCurrent()) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Access authority request failed",
        );
        setErrorCause(cause);
      }
    } finally {
      if (request.isCurrent()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const requestGate = gate.current;
    const restore = () => {
      const next = currentQuery();
      setQuery(next);
      setDraft(next);
      // 回退到的那一页是哪一页，历史条目里没记；不知道就说不知道，把「上一页」置灰。
      setCursorTrail([]);
      refreshTarget();
      void load(next);
    };
    restore();
    window.addEventListener("popstate", restore);
    window.addEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, restore);
    return () => {
      requestGate.invalidate();
      window.removeEventListener("popstate", restore);
      window.removeEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, restore);
    };
  }, [load, refreshTarget]);

  // INTENT: 输入框每敲一个字符都查一次是浪费；停手 400ms 再查。查失败不拦操作——
  //         写命令自己会报错，这里只是「先看一眼」，看不到也不该把按钮锁死。
  // INTENT: 不在这里把上一次的结果清空——渲染侧靠 lookup.userId 对不对得上来判断新鲜度，
  //         在 effect 里同步 setState 只会多一轮级联渲染（react-hooks/set-state-in-effect）。
  useEffect(() => {
    if (!permissions.managePermissions || !targetUserId) return;
    const requestGate = permissionGate.current;
    const timer = window.setTimeout(async () => {
      const request = requestGate.begin();
      try {
        const data = accessUserPermissionListSchema.parse(
          await apiGet<unknown>(
            `/api/v2/admin/users/${encodeURIComponent(targetUserId)}/permissions`,
          ),
        );
        if (request.isCurrent()) {
          setPermissionLookup({ userId: targetUserId, data, failed: false });
        }
      } catch {
        if (request.isCurrent()) {
          setPermissionLookup({ userId: targetUserId, data: null, failed: true });
        }
      }
    }, 400);
    return () => {
      window.clearTimeout(timer);
      requestGate.invalidate();
    };
  }, [accessRevision, permissions.managePermissions, targetUserId]);

  // SPEC: 授权包与权限覆盖盯的是同一个目标用户，所以共用 targetUserId，不再多要一个 ID。
  // INTENT: 撤销之前必须先知道他现在有什么——没有这份清单，运营只能凭记忆猜 bundleKey，
  //         猜错了就是一条 400（确认串对不上）而不是一句"他本来就没有这个包"。
  useEffect(() => {
    if (!permissions.managePermissions || !targetUserId) return;
    const requestGate = bundleGate.current;
    const timer = window.setTimeout(async () => {
      const request = requestGate.begin();
      try {
        const data = adminGrantBundleListSchema.parse(
          await apiGet<unknown>(
            `/api/v2/admin/users/${encodeURIComponent(targetUserId)}/grant-bundles`,
          ),
        );
        if (request.isCurrent()) setBundleLookup({ userId: targetUserId, data, failed: false });
      } catch {
        if (request.isCurrent()) setBundleLookup({ userId: targetUserId, data: null, failed: true });
      }
    }, 400);
    return () => {
      window.clearTimeout(timer);
      requestGate.invalidate();
    };
  }, [accessRevision, permissions.managePermissions, targetUserId]);

  // SPEC: 任何改变结果集的动作都回到第一页 —— 所以 trail 默认清空，只有翻页自己传轨迹。
  const navigate = useCallback((
    next: AccessQuery,
    mode: "push" | "replace" = "push",
    trail: string[] = [],
  ) => {
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
    setCursorTrail(trail);
    void load(next);
  }, [load]);

  const selectTarget = useCallback((userId: string, user: AccessUserListItem | null = null) => {
    setPermissionDraft({ ...emptyPermission, userId });
    setSelectedUser(user);
    refreshTarget();
    setRoleChoice(user?.role ?? "support");
    // INVARIANT: 切换对象时，不能把上一个人的角色授权范围带给下一个人。
    setBundleCharacterIds("");
    if (user || !userId) {
      window.requestAnimationFrame(() => {
        targetField.current?.scrollIntoView({ block: "start" });
        targetField.current?.querySelector("input")?.focus({ preventScroll: true });
      });
    }
  }, [refreshTarget]);

  function confirmCommand(input: AccessCommand) {
    setConfirmation({
      title: input.title,
      destructive: { expectedName: input.expected, inputLabel: t("Confirmation") },
      consequence: input.consequence,
      reasonLabel: t("Reason"),
      submitLabel: t("Confirm"),
      onSubmit: async (reason) => {
        await apiWrite(
          input.endpoint,
          input.method ?? "POST",
          { ...input.payload(reason), confirmation: input.expected },
        );
        toast({ tone: "success", title: input.completed });
        refreshTarget();
        navigate({ ...query, cursor: "" }, "replace");
      },
    });
  }

  const users = data?.items ?? [];
  const targetUser = users.find((user) => user.id === targetUserId)
    ?? (selectedUser?.id === targetUserId ? selectedUser : null);
  const targetAccess = bundleLookup?.userId === targetUserId ? bundleLookup.data?.user : null;
  const currentRole = permissionLookup?.userId === targetUserId && permissionLookup.data
    ? permissionLookup.data.role
    : targetAccess
      ? targetAccess.role
      : targetUser?.role;
  // 筛选可能把变更后的用户移出名录；当前状态以重新读取的对象为准，不能停留在选择时的行快照。
  const currentStatus = targetAccess?.status ?? targetUser?.status;
  const filtered = Boolean(
    query.search || query.role || query.status || query.dataClass,
  );
  return (
    <section className="space-y-5">
      <PageHeader
        purpose={t("Find a user and review their current access before changing their role, permissions, or account status. Changes require confirmation and an audit reason.")}
        title={t("Team Access")}
      />
      <div
        className="flex flex-wrap justify-between gap-2 text-xs text-[var(--ad-text-muted)]"
        role="status"
      >
        {/* 首次加载时下方的骨架屏已经在说"正在加载"，这里再说一遍就是两个加载态。 */}
        <span>{data || error ? freshness(data, loading, error, refreshedAt, t, format) : ""}</span>
        <span className="flex gap-3 font-semibold">
          {!permissions.managePermissions ? <PermissionNotice permission="user.role.write" /> : null}
          {!permissions.changeStatus ? <PermissionNotice permission="user.status.write" /> : null}
        </span>
      </div>
      <AccessFilters
        loading={loading}
        query={query}
        draft={draft}
        onChange={(patch) => setDraft((value) => ({ ...value, ...patch }))}
        onApply={(next) => navigate({ ...next, cursor: "" })}
      />
      {permissions.managePermissions ? (
        <section
          className="scroll-mt-24 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"
          ref={targetField}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="font-semibold">{t(targetUserId ? "Manage access" : "Choose a user")}</h3>
              {targetUser ? (
                <p className="mt-1 break-words text-sm">
                  <strong>{targetUser.displayName || targetUser.email}</strong>
                  {targetUser.displayName ? <span className="ml-2 text-[var(--ad-text-muted)]">{targetUser.email}</span> : null}
                </p>
              ) : (
                <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
                  {t("Select a user in the list below, or enter their ID to review access.")}
                </p>
              )}
              {targetUserId && currentRole ? (
                <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
                  {t("Current role")}: {valueLabel(currentRole)}
                  {currentStatus ? <> · {valueLabel(currentStatus)}</> : null}
                  {targetUser ? <> · {valueLabel(targetUser.dataClass)}</> : null}
                </p>
              ) : null}
            </div>
            {targetUserId ? (
              <div className="flex flex-wrap gap-2">
                <button className="min-h-9 rounded-md border border-[var(--ad-border)] px-3 text-xs font-semibold" onClick={refreshTarget} type="button">{t("Refresh access")}</button>
                <button className="min-h-9 rounded-md border border-[var(--ad-border)] px-3 text-xs font-semibold" onClick={() => selectTarget("")} type="button">
                  {t("Clear selection")}
                </button>
              </div>
            ) : null}
          </div>
          <div className="mt-3 max-w-xl">
            <Field label="Target user ID" onChange={(userId) => selectTarget(userId)} value={permissionDraft.userId} />
          </div>
        </section>
      ) : null}
      {/* INVARIANT: 角色、授权包和单项覆盖共享一个明确的操作对象。 */}
      {permissions.managePermissions && targetUserId ? (
        <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
          <h3 className="font-semibold">{t("Role and grant bundles")}</h3>
          <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
            {t("Target user: {userId}", { userId: targetUserId })}
          </p>
          <GrantedBundles
            lookup={bundleLookup}
            onRevoke={(bundle) =>
              confirmCommand({
                title: t("Revoke bundle"),
                completed: t("Revoked {bundle}.", { bundle: valueLabel(bundle.bundleKey) }),
                endpoint: `/api/v2/admin/users/${encodeURIComponent(bundle.userId)}/grant-bundles/${encodeURIComponent(bundle.bundleKey)}`,
                method: "DELETE",
                expected: accessBundleConfirmation(bundle.userId, bundle.bundleKey, "revoke"),
                consequence: {
                  effect: t("Removes this bundle's grants. Permissions supplied by the role, other bundles, or individual overrides remain in effect."),
                  reversible: true,
                },
                payload: (reason) => ({ reason }),
              })
            }
            targetUserId={targetUserId}
          />
          <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
            <Select
              label="Role"
              onChange={(role) => setRoleChoice(role as AccessUserRole)}
              optionLabel={valueLabel}
              options={[...ACCESS_ROLES]}
              value={roleChoice}
            />
            <div className="flex items-end">
              <button
                className="inline-flex min-h-11 items-center gap-2 rounded-md border border-[var(--ad-border)] px-4 text-sm font-semibold disabled:opacity-50"
                disabled={!targetUserId}
                onClick={() => {
                  if (!targetUserId) return;
                  confirmCommand({
                    title: t("Change role"),
                    completed: t("Role changed to {role}.", { role: valueLabel(roleChoice) }),
                    endpoint: `/api/v2/admin/users/${encodeURIComponent(targetUserId)}/role`,
                    expected: accessRoleConfirmation(targetUserId, roleChoice),
                    consequence: {
                      effect: t("Changes the role's permissions; grant bundles and individual overrides remain in effect."),
                      reversible: true,
                    },
                    payload: (reason) => ({ role: roleChoice, reason }),
                  });
                }}
                type="button"
              >
                <UserCog className="h-4 w-4" />
                {t("Change role")}
              </button>
            </div>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
            <Select
              label="Grant bundle"
              onChange={(bundleKey) => setBundleChoice(bundleKey as AdminGrantBundleKey)}
              optionLabel={valueLabel}
              options={ADMIN_GRANT_BUNDLE_KEYS}
              value={bundleChoice}
            />
            <div className="flex items-end">
              <button
                className="inline-flex min-h-11 items-center gap-2 rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white disabled:opacity-50"
                disabled={!targetUserId || (needsCharacterScope && scopedCharacterIds.length === 0)}
                onClick={() => {
                  if (!targetUserId) return;
                  confirmCommand({
                    title: t("Grant bundle"),
                    completed: t("Granted {bundle}.", { bundle: valueLabel(bundleChoice) }),
                    endpoint: `/api/v2/admin/users/${encodeURIComponent(targetUserId)}/grant-bundles`,
                    expected: accessBundleConfirmation(targetUserId, bundleChoice, "grant"),
                    consequence: {
                      effect: t("Adds the bundle's grants on top of the role. Individual revocations still take precedence."),
                      reversible: true,
                    },
                    // INVARIANT: 只有需要范围的包才带 scope —— 服务端对其余包收到 scope 会 400。
                    payload: (reason) => needsCharacterScope
                      ? { bundleKey: bundleChoice, reason, scope: { characterIds: scopedCharacterIds } }
                      : { bundleKey: bundleChoice, reason },
                  });
                }}
                type="button"
              >
                <ShieldCheck className="h-4 w-4" />
                {t("Grant bundle")}
              </button>
            </div>
          </div>
          {/* SPEC: 需要范围的包，范围就是它的必填项 —— 不填不给按。
              INTENT: 没有这个输入框时，character_producer（下拉框的默认值）发出去必定是一条
              "Character producer grants require at least one assigned Character" 的 400。 */}
          {needsCharacterScope ? (
            <div className="mt-3">
              <Field
                label="Assigned character IDs"
                onChange={setBundleCharacterIds}
                value={bundleCharacterIds}
              />
              <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
                {scopedCharacterIds.length > 0
                  ? t("{count} characters in scope", { count: scopedCharacterIds.length })
                  : t("This bundle only grants access to the characters listed here.")}
              </p>
            </div>
          ) : null}
        </section>
      ) : null}
      {permissions.managePermissions && targetUserId ? (
        <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
          <h3 className="font-semibold">{t("Permission override")}</h3>
          <p className="mt-1 text-xs text-[var(--ad-text-muted)]">

            {t("Grant, revoke, or clear one effective permission without changing the user role.")}
          </p>
          <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_140px_auto]">
            {/* INTENT: 下拉里原本是 62 个权限码。管理员不背这张表——按能力名选，
                码本身留在下面的说明行里，需要核对时还看得到。 */}
            <Select
              label="Permission key"
              onChange={(permissionKey) =>
                setPermissionDraft((value) => ({
                  ...value,
                  permissionKey: permissionKey as AdminPermissionKey,
                }))
              }
              optionLabel={(option) => t(permissionLabel(option as AdminPermissionKey))}
              options={[...ADMIN_PERMISSION_KEYS]}
              value={permissionDraft.permissionKey}
            />
            <Select
              optionLabel={valueLabel}
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
                  // INTENT: 标题里印能力名而不是权限码——运营在这一步要确认的是「我在给谁开什么」。
                  title: t("{effect} the permission for: {capability}", {
                    effect: valueLabel(permissionDraft.effect),
                    capability: t(permissionLabel(permissionDraft.permissionKey)),
                  }),
                  completed: t("Permission override applied to {user}", { user: userId }),
                  endpoint: `/api/v2/admin/users/${encodeURIComponent(userId)}/permissions`,
                  expected: accessPermissionConfirmation(
                    userId,
                    permissionDraft.permissionKey,
                    permissionDraft.effect,
                  ),
                  // INTENT: 覆盖立即生效但可以再改一次改回来，所以是可撤回的。
                  consequence: {
                    effect: t("Updates the individual override on the next request. Clearing it restores the permissions from the role and active grant bundles."),
                    reversible: true,
                  },
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

              {t("Apply")}
            </button>
          </div>
          <PermissionImpact
            draft={permissionDraft}
            lookup={permissionLookup}
            targetUserId={targetUserId}
          />
        </section>
      ) : null}
      {error ? (
        <AuthorityRequestError
          requestKind="read"
          cause={errorCause}
          message={error}
          onRetry={() => void load(query)}
          snapshotAt={data ? refreshedAt : null}
        />
      ) : null}
      {loading && (!data || users.length === 0) ? (
        <div
          aria-label={t("Loading team access…")}
          className="rounded-lg border border-[var(--ad-border)] p-4"
          role="status"
        >
          <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />

          {t("Loading team access…")}
        </div>
      ) : data ? (
        users.length === 0 ? (
          <EmptyState
            kind={filtered ? "filtered" : "empty"}
            action={
              filtered ? (
                <button
                  className="min-h-11 rounded-md border px-4"
                  onClick={() => navigate(defaultAccessQuery)}
                  type="button"
                >

                  {t("Clear filters")}
                </button>
              ) : undefined
            }
            hint={
              filtered
                ? "Change or clear the filters to see other users."
                : "There are no user accounts to display."
            }
            title={filtered ? "No users match these filters" : "No users"}
          />
        ) : (
          <AccessUserTable
            users={users}
            canChangeStatus={permissions.changeStatus}
            onSelect={permissions.managePermissions ? (user) => selectTarget(user.id, user) : undefined}
            onConfirm={confirmCommand}
          />
        )
      ) : null}
      {data ? (
        <Pagination
          hasNext={Boolean(data.pageInfo.hasNextPage && data.pageInfo.endCursor)}
          hasPrevious={Boolean(query.cursor)}
          loading={loading}
          onNext={() => {
            const endCursor = data.pageInfo.endCursor;
            if (!endCursor) return;
            navigate({ ...query, cursor: endCursor }, "push", [...cursorTrail, query.cursor]);
          }}
          onPrevious={() =>
            navigate({ ...query, cursor: cursorTrail.at(-1) ?? "" }, "push", cursorTrail.slice(0, -1))
          }
          previousLabel={query.cursor && cursorTrail.length === 0 ? t("Back to first page") : undefined}
          page={!query.cursor ? 1 : cursorTrail[0] === "" ? cursorTrail.length + 1 : null}
          pageSize={ACCESS_PAGE_SIZE}
          rowCount={users.length}
        />
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

/**
 * SPEC: 提交前把「这个权限是什么能力、这个人现在有没有、改完会变成什么」摆在按钮旁边。
 *
 * INTENT: 原来这里只有三个下拉。管理员看不到目标现在的状态，最常见的两种误操作没人拦：
 * 给一个已经通过角色拿到该能力的人再发一条 grant（多一条永久覆盖，将来改角色也收不回），
 * 以及对一条根本不存在的覆盖执行 clear（什么都没发生，但审计里多一条记录）。
 * INVARIANT: 只讲 authority 真回给我们的东西。查不到就说查不到，不猜。
 */
// SPEC: 撤销之前先让运营看见他现在有什么包。
// INTENT: 没有这份清单，bundleKey 只能靠记；记错了后端回的是确认串不匹配的 400，
//         而不是"他本来就没有这个包"——运营读不出真正的原因。
function GrantedBundles({
  lookup,
  onRevoke,
  targetUserId,
}: {
  lookup: BundleLookup | null;
  onRevoke: (bundle: AdminGrantBundle) => void;
  targetUserId: string;
}) {
  const { t, value: valueLabel } = useAdminI18n();
  const format = useAdminFormat();
  if (!targetUserId) return null;
  if (!lookup || lookup.userId !== targetUserId) {
    return <p className="mt-3 text-xs text-[var(--ad-text-muted)]">{t("Loading grant bundles…")}</p>;
  }
  if (lookup.failed || !lookup.data) {
    return (
      <p className="mt-3 text-xs text-[var(--ad-text-muted)]">
        {t("Grant bundles for this user could not be read.")}
      </p>
    );
  }
  // INVARIANT: 只对权威判为 active 的包提供撤销操作。
  const active = lookup.data.items.filter((bundle) => bundle.state === "active");
  if (active.length === 0) {
    return (
      <p className="mt-3 text-xs text-[var(--ad-text-muted)]">
        {t("No active grant bundles.")}
      </p>
    );
  }
  return (
    <ul className="mt-3 grid gap-2 sm:grid-cols-2">
      {active.map((bundle) => (
        <li
          className="min-w-0 rounded-md border border-[var(--ad-border)] p-3 text-xs"
          key={bundle.id}
        >
          <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-semibold">{valueLabel(bundle.bundleKey)}</p>
            <p className="mt-1 text-[var(--ad-text-muted)]">{t("{count} capabilities in this bundle", { count: bundle.permissions.length })}</p>
            <p className="mt-1 text-[var(--ad-text-muted)]">
              {bundle.scope ? t("{count} assigned characters", { count: bundle.scope.characterIds.length }) : t("All resources allowed by these capabilities")}
            </p>
            <p className="mt-1 text-[var(--ad-text-muted)]">{bundle.expiresAt ? t("Expires {time}", { time: format.dateTime(bundle.expiresAt) }) : t("No expiry")}</p>
          </div>
          <button
            aria-label={t("Revoke {bundle}", { bundle: valueLabel(bundle.bundleKey) })}
            className="grid min-h-8 min-w-8 place-items-center rounded text-[var(--ad-red-text)]"
            onClick={() => onRevoke(bundle)}
            type="button"
          >
            <X className="h-3.5 w-3.5" />
          </button>
          </div>
          <details className="mt-2 border-t border-[var(--ad-border)] pt-2">
            <summary className="cursor-pointer font-semibold">{t("Review granted capabilities and scope")}</summary>
            {bundle.scope ? <ul className="mt-2 space-y-1 break-words font-mono [overflow-wrap:anywhere]">{bundle.scope.characterIds.map((id) => <li key={id}>{id}</li>)}</ul> : null}
            <ul className="mt-2 list-disc space-y-1 pl-4">{bundle.permissions.map((key) => <li key={key}>{t(permissionLabel(key))}</li>)}</ul>
          </details>
        </li>
      ))}
    </ul>
  );
}

function PermissionImpact({
  draft,
  lookup,
  targetUserId,
}: {
  draft: PermissionDraft;
  lookup: PermissionLookup | null;
  targetUserId: string;
}) {
  const { t, value: valueLabel } = useAdminI18n();
  const capability = t(permissionLabel(draft.permissionKey));
  const fresh = lookup && lookup.userId === targetUserId ? lookup : null;
  const authority = fresh?.data ?? null;
  const alreadyEffective = authority?.effective.includes(draft.permissionKey) ?? null;
  const existingOverride =
    authority?.overrides.find((override) => override.permissionKey === draft.permissionKey) ?? null;
  return (
    <div className="mt-3 border-t border-[var(--ad-border)] pt-3 text-xs text-[var(--ad-text-muted)]">
      <p>
        <strong className="text-[var(--ad-text)]">{capability}</strong>
        {" · "}
        <code className="font-mono">{draft.permissionKey}</code>
      </p>
      {!targetUserId ? (
        <p className="mt-1">{t("Enter a user ID to see what they can do today.")}</p>
      ) : !fresh ? (
        <p className="mt-1">{t("Checking what this user can do today…")}</p>
      ) : fresh.failed ? (
        <p className="mt-1">
          {t("Could not read this user's current permissions. The change below still applies as written.")}
        </p>
      ) : authority ? (
        <>
          <p className="mt-1">
            {t("Role")}: {valueLabel(authority.role)}
            {" · "}
            {alreadyEffective
              ? t("already has this capability")
              : t("does not have this capability")}
            {" · "}
            {t("{count} capabilities in total", { count: authority.effective.length })}
          </p>
          <p className="mt-1">
            {existingOverride
              ? t("An existing {effect} override is already recorded for this capability; applying a new one replaces it.", {
                  effect: valueLabel(existingOverride.effect),
                })
              : t("No individual override is recorded for this capability.")}
          </p>
          <p className="mt-1 text-[var(--ad-text)]">{outcome(draft, alreadyEffective, existingOverride, t)}</p>
        </>
      ) : null}
    </div>
  );
}

/**
 * INTENT: 一句话说清「点下去之后这个人多了/少了什么」。clear 是最容易误解的一个——
 * 它是删除单项覆盖；删除后由角色与有效授权包共同决定，不能承诺一定授予或撤销。
 */
function outcome(
  draft: PermissionDraft,
  alreadyEffective: boolean | null,
  existingOverride: AccessPermissionOverride | null,
  t: (key: string, values?: Record<string, string | number>) => string,
) {
  if (draft.effect === "clear") {
    return existingOverride
      ? t("Applying this removes the override. The role and active grant bundles then decide this capability.")
      : t("There is no override to remove, so nothing changes.");
  }
  if (draft.effect === "grant") {
    return alreadyEffective
      ? t("This user can already do it. Applying this pins the capability on with an override that outlives any role change.")
      : t("Applying this gives the user the capability.");
  }
  return alreadyEffective
    ? t("Applying this takes the capability away.")
    : t("This user cannot do it today, so applying this only pins it off.");
}

function AccessFilters({ loading, query, draft, onApply, onChange }: {
  loading: boolean;
  query: AccessQuery;
  draft: AccessQuery;
  onApply: (next: AccessQuery) => void;
  onChange: (patch: Partial<AccessQuery>) => void;
}) {
  const { t, value: valueLabel } = useAdminI18n();
  const filterChips = ([
    ["search", "Search users"], ["role", "Role"], ["status", "Status"], ["dataClass", "Data class"],
  ] as const).filter(([key]) => query[key]).map(([key, label]) => ({
    key, label: t(label), value: key === "search" ? query[key] : valueLabel(query[key]),
    onClear: () => onApply({ ...query, [key]: "", cursor: "" }),
  }));
  return (
      <FilterBar
        busy={loading}
        chips={filterChips}
        collapsible
        onApply={() => onApply(draft)}
        onReset={() => onApply(defaultAccessQuery)}
        onSearch={(search) => onChange({ search })}
        search={draft.search}
        searchPlaceholder={t("Search users")}
        selects={[
          { name: t("Role"), value: draft.role, onChange: (role) => onChange({ role }), options: ["", ...ACCESS_ROLES].map((value) => ({ value, label: value ? valueLabel(value) : t("All") })) },
          { name: t("Status"), value: draft.status, onChange: (status) => onChange({ status }), options: ["", "active", "suspended", "deleted"].map((value) => ({ value, label: value ? valueLabel(value) : t("All") })) },
          { name: t("Data class"), value: draft.dataClass, onChange: (dataClass) => onChange({ dataClass: dataClass as AccessDataClassFilter }), options: ["", ...ADMIN_DATA_CLASSES].map((value) => ({ value, label: value ? valueLabel(value) : t("All") })) },
        ]}
      />
  );
}

function AccessUserTable({ users, canChangeStatus, onSelect, onConfirm }: {
  users: readonly AccessUserListItem[];
  canChangeStatus: boolean;
  onSelect?: (user: AccessUserListItem) => void;
  onConfirm: (command: AccessCommand) => void;
}) {
  const { t, value: valueLabel } = useAdminI18n();
  const format = useAdminFormat();
  return (
          <DataTable
            caption="Users"
            // INTENT: 姓名、邮箱和 ID 放在同一身份列，选人时无需在三列之间反复对照。
            headers={[
              { label: "User", width: "17rem" },
              // 三个枚举列：中文最长四字（前台用户 / 测试数据），truncate 保证它们不折行。
              { label: "Role", truncate: true, width: "4.5rem" },
              { label: "Status", truncate: true, width: "4.5rem" },
              { label: "Data class", truncate: true, width: "5rem" },
              { label: "Dreamcoins", align: "right", width: "4.5rem" },
              // 中文 dateStyle:medium + timeStyle:short 实测 ~142px；truncate 在这里的作用是不折行。
              { label: "Created", truncate: true, width: "9.5rem" },
              // 单个按钮（封禁 / 恢复）或一句只读说明，不截断，让说明自己折行。
              { label: "Actions", width: "7rem" },
            ]}
            minimumWidthClassName="min-w-[1080px]"
            rows={userTableRows(
              users,
              canChangeStatus,
              onSelect,
              onConfirm,
              t,
              format,
              valueLabel,
            )}
          />
  );
}

function userTableRows(
  users: readonly AccessUserListItem[],
  canChangeStatus: boolean,
  onSelect: ((user: AccessUserListItem) => void) | undefined,
  confirm: (input: AccessCommand) => void,
  t: (key: string, values?: Record<string, string | number>) => string,
  format: ReturnType<typeof useAdminFormat>,
  // 枚举列专用：format.display 不查枚举译文，角色/状态/数据分级要走这个。
  valueLabel: (key: string) => string,
): DataTableRow[] {
  return users.map((user, index) => {
    const id = text(user.id);
    const status = text(user.status);
    const next = status === "suspended" ? "active" : "suspended";
    return {
      id: id || `user-${index}`,
      cells: [
        <div className="min-w-0 max-w-[17rem]" key="user">
          {onSelect ? (
            <button
              aria-label={t("Manage access for {user}", { user: user.displayName || user.email })}
              className="block max-w-full truncate text-left font-semibold underline decoration-[var(--ad-border)] underline-offset-4 hover:decoration-current"
              onClick={() => onSelect(user)}
              type="button"
            >
              {user.displayName || user.email}
            </button>
          ) : <p className="truncate font-semibold">{user.displayName || user.email}</p>}
          <p className="mt-0.5 truncate text-xs text-[var(--ad-text-muted)]" title={user.email}>{user.email}</p>
          <CopyableId value={id} />
        </div>,
        // SPEC: 角色 / 状态 / 数据分级是枚举，走 valueLabel 而不是 format.display。
        // INTENT: format.display 只做取值与缺省处理，不查枚举译文，于是中文界面上这三列
        //         一直印着 user / active / deleted / fixture / customer。同文件 :534 早就
        //         用的是 valueLabel —— 同一份数据两处写法不一致，这里对齐过去。
        valueLabel(format.text(user.role)),
        valueLabel(format.text(user.status)),
        valueLabel(format.text(user.dataClass)),
        // 列头已经写着 Dreamcoins，每格再缀一遍单位是噪音。
        <span className="tabular-nums" key="dreamcoins">{format.dreamcoins(user.dreamcoins, { unit: false })}</span>,
        format.dateTime(user.createdAt),
        canChangeStatus && status !== "deleted" ? (
          <button
            aria-label={next === "active" ? t("Restore") : t("Suspend")}
            className="inline-flex min-h-9 items-center gap-1 rounded border px-2"
            onClick={() =>
              confirm({
                title:
                  next === "active"
                    ? t("Restore access for {user}", { user: id })
                    : t("Suspend access for {user}", { user: id }),
                completed:
                  next === "active"
                    ? t("Access restored for {user}", { user: id })
                    : t("Access suspended for {user}", { user: id }),
                endpoint: `/api/v2/admin/users/${encodeURIComponent(id)}/status`,
                expected: accessStatusConfirmation(id, next),
                consequence: {
                  effect:
                    next === "active"
                      ? t("The account can sign in and spend again straight away.")
                      : t("The account is signed out and blocked from spending straight away. Restoring it is one click from this same row."),
                  reversible: true,
                },
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
            {next === "active" ? t("Restore") : t("Suspend")}
          </button>
        ) : (
          <AdminText key="read-only" text={status === "deleted" ? "Controlled by account deletion" : "Read only"} />
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
// INTENT: 这四句原来是裸英文字符串，中文界面里照样印英文；时刻还走裸 toLocaleTimeString()，
//         跟着浏览器语言漂。两件事一起收：文案过 t()，时刻过 ui/format。
function freshness(
  data: AccessUserListResponse | null,
  loading: boolean,
  error: string | null,
  refreshedAt: string | null,
  t: (key: string, values?: Record<string, string | number>) => string,
  format: ReturnType<typeof useAdminFormat>,
) {
  const time = refreshedAt ? format.time(refreshedAt) : t("unknown");
  if (loading && data) return t("Refreshing · as of {time}", { time });
  if (error && data) return t("Stale · last good {time}", { time });
  if (error) return t("unavailable");
  if (data) return t("As of {time}", { time });
  return t("loading…");
}
function Field({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  // label 在接收方过 t()，一处修好覆盖全部调用点（搜索框、权限用户 ID、权限键…）。
  const { t } = useAdminI18n();
  return (
    <label className="grid min-w-0 gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">
      {t(label)}
      <input
        className="min-h-11 min-w-0 w-full rounded-md border bg-[var(--ad-surface)] px-3 text-sm"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      />
    </label>
  );
}
function Select({
  label,
  onChange,
  optionLabel,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  optionLabel?: (option: string) => string;
  options: string[];
  value: string;
}) {
  const { t } = useAdminI18n();
  return (
    <label className="grid min-w-0 gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">
      {t(label)}
      <select
        className="min-h-11 min-w-0 w-full rounded-md border bg-[var(--ad-surface)] px-3 text-sm"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {options.map((option) => (
          <option key={option || "all"} value={option}>
            {option ? (optionLabel?.(option) ?? option) : t("All")}
          </option>
        ))}
      </select>
    </label>
  );
}
