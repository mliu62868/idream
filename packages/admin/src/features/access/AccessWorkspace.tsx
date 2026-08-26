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
import type { FormEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Ban, Check, Loader2, ShieldCheck, UserCog, X } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import {
  ConfirmDialog,
  type ConfirmSpec,
} from "@/components/admin/ui/ConfirmDialog";
import { DataTable, type DataTableRow } from "@/components/admin/ui/DataTable";
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
  // 游标分页没有页码，只有「上一页用的是哪个游标」。这条轨迹就是 Pagination 的第 N 页。
  const [cursorTrail, setCursorTrail] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCause, setErrorCause] = useState<unknown>(undefined);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [permissionDraft, setPermissionDraft] = useState(emptyPermission);
  const [permissionLookup, setPermissionLookup] = useState<PermissionLookup | null>(null);
  const [bundleLookup, setBundleLookup] = useState<BundleLookup | null>(null);
  const [roleChoice, setRoleChoice] = useState<AccessUserRole>("support");
  const [bundleChoice, setBundleChoice] = useState<AdminGrantBundleKey>(ADMIN_GRANT_BUNDLE_KEYS[0]);
  const [bundleCharacterIds, setBundleCharacterIds] = useState("");
  // SPEC: 写命令成功后重新拉一次授权包清单。
  // INTENT: 不加这个，撤销成功后芯片还挂在那里、授予成功后新包不出现 —— 运营会以为命令没生效
  //         而再点一次。navigate() 只重载用户**列表**，碰不到这份按目标用户拉的清单。
  const [commandNonce, setCommandNonce] = useState(0);
  const [confirmation, setConfirmation] = useState<ConfirmSpec | null>(null);
  const gate = useRef(createLatestRequestGate());
  const permissionGate = useRef(createLatestRequestGate());
  const bundleGate = useRef(createLatestRequestGate());
  const targetUserId = permissionDraft.userId.trim();
  const needsCharacterScope = bundleNeedsCharacterScope(bundleChoice);
  const scopedCharacterIds = parseCharacterIds(bundleCharacterIds);

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
  }, [load]);

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
  }, [permissions.managePermissions, targetUserId]);

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
  }, [commandNonce, permissions.managePermissions, targetUserId]);

  // SPEC: 任何改变结果集的动作都回到第一页 —— 所以 trail 默认清空，只有翻页自己传轨迹。
  function navigate(
    next: AccessQuery,
    mode: "push" | "replace" = "push",
    trail: string[] = [],
  ) {
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
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate({ ...draft, cursor: "" });
  }

  function confirmCommand(input: AccessCommand) {
    const idempotencyKey = crypto.randomUUID();
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
          { "idempotency-key": idempotencyKey },
        );
        toast({ tone: "success", title: input.completed });
        setCommandNonce((value) => value + 1);
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
        purpose={t("Search users, apply narrowly scoped permission overrides, and suspend or restore access through audited commands.")}
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
          optionLabel={valueLabel}
          label="Role"
          onChange={(role) => setDraft((value) => ({ ...value, role }))}
          options={["", ...ACCESS_ROLES]}
          value={draft.role}
        />
        <Select
          optionLabel={valueLabel}
          label="Status"
          onChange={(status) => setDraft((value) => ({ ...value, status }))}
          options={["", "active", "suspended", "deleted"]}
          value={draft.status}
        />
        <Select
          optionLabel={valueLabel}
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

            {t("Filter users")}
          </button>
          {filtered ? (
            <button
              aria-label={t("Clear access filters")}
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
          <h3 className="font-semibold">{t("Permission override")}</h3>
          <p className="mt-1 text-xs text-[var(--ad-text-muted)]">

            {t("Grant, revoke, or clear one effective permission without changing the user role.")}
          </p>
          <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_140px_auto]">
            <Field
              label="Permission user ID"
              onChange={(userId) =>
                setPermissionDraft((value) => ({ ...value, userId }))
              }
              value={permissionDraft.userId}
            />
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
                  endpoint: `/api/v2/admin/users/${userId}/permissions`,
                  expected: accessPermissionConfirmation(
                    userId,
                    permissionDraft.permissionKey,
                    permissionDraft.effect,
                  ),
                  // INTENT: 覆盖立即生效但可以再改一次改回来，所以是可撤回的。
                  consequence: {
                    effect: t("The override takes effect on the user's next request. Applying the opposite effect reverses it."),
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
      {/* SPEC: 角色与授权包 —— 后端 API 一直都在（users/:id/role、users/:id/grant-bundles），
          界面上此前没有任何入口，运营只能一条一条地打权限覆盖补丁。
          INTENT: 复用上方的目标用户 ID，不再要第二个输入框：同一个人的"他是什么角色 /
          他有哪些包 / 他被单独开了哪些口子"本来就该在一屏里看完。 */}
      {permissions.managePermissions ? (
        <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
          <h3 className="font-semibold">{t("Role and grant bundles")}</h3>
          <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
            {targetUserId
              ? t("Target user: {userId}", { userId: targetUserId })
              : t("Enter a user ID in Permission override above to act on someone.")}
          </p>
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
                      effect: t("Replaces every capability the old role granted."),
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
                      effect: t("Adds every capability in the bundle on top of the role."),
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
                  effect: t("Removes every capability the bundle added."),
                  reversible: true,
                },
                payload: (reason) => ({ reason }),
              })
            }
            targetUserId={targetUserId}
          />
        </section>
      ) : null}
      {error ? (
        <AuthorityRequestError
          cause={errorCause}
          message={error}
          onRetry={() => void load(query)}
          snapshotAt={data ? refreshedAt : null}
        />
      ) : null}
      {!data && loading ? (
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
                ? "The complete access authority query returned no matches."
                : "No users exist in the authority."
            }
            title={filtered ? "No users match these filters" : "No users"}
          />
        ) : (
          <DataTable
            caption="Users"
            // SPEC: width 是**文本盒**宽度，单元格左右还各有 1rem 内边距，真实列宽 ≈ width + 2rem；
            //       九列合计 ~1240px，就是下面的 minimumWidthClassName。
            // INTENT: 这张表原来九列全传字符串、连最小宽度都没传，于是用默认的 min-w-[640px] 去挤
            //         1204px 的内容区：邮箱一列独吞 469px，角色 / 状态 / 数据分级各剩 46px——
            //         中文被压成「前/台/用/户」的竖排，创建时间折成三行。
            // INTENT: 总宽卡在 1240px 而不是给每列都留宽裕量：再宽一点「操作」列的封禁按钮就滚出屏幕，
            //         运营得先横滚才能点。现在 1512 视口下只差 36px，按钮仍在第一屏。
            headers={[
              // ID 与邮箱截断后完整值仍在 title 悬停里（DataTable 给字符串单元格自动挂 title）。
              { label: "ID", truncate: true, width: "7rem" },
              { label: "Email", truncate: true, width: "10rem" },
              { label: "Display name", truncate: true, width: "7.5rem" },
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
            minimumWidthClassName="min-w-[1240px]"
            rows={userTableRows(
              users,
              permissions.changeStatus,
              confirmCommand,
              t,
              format,
              valueLabel,
            )}
          />
        )
      ) : null}
      {data ? (
        <Pagination
          hasNext={Boolean(data.pageInfo.hasNextPage && data.pageInfo.endCursor)}
          hasPrevious={cursorTrail.length > 0}
          loading={loading}
          onNext={() => {
            const endCursor = data.pageInfo.endCursor;
            if (!endCursor) return;
            navigate({ ...query, cursor: endCursor }, "push", [...cursorTrail, query.cursor]);
          }}
          onPrevious={() =>
            navigate({ ...query, cursor: cursorTrail.at(-1) ?? "" }, "push", cursorTrail.slice(0, -1))
          }
          page={cursorTrail.length + 1}
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
  // INVARIANT: 只有 state=active 的包能撤销。已过期/已撤销的仍然列出来（那是这个人权限
  //            历史的一部分），但不给撤销按钮 —— 对它再发一次撤销只会换回一条 400。
  const active = lookup.data.items.filter((bundle) => bundle.state === "active");
  if (active.length === 0) {
    return (
      <p className="mt-3 text-xs text-[var(--ad-text-muted)]">
        {t("No bundle is granted; the role decides every capability today.")}
      </p>
    );
  }
  return (
    <ul className="mt-3 flex flex-wrap gap-2">
      {active.map((bundle) => (
        <li
          className="inline-flex items-center gap-2 rounded-md border border-[var(--ad-border)] px-3 py-1.5 text-xs"
          key={bundle.id}
        >
          <span className="font-semibold">{valueLabel(bundle.bundleKey)}</span>
          <button
            aria-label={t("Revoke {bundle}", { bundle: valueLabel(bundle.bundleKey) })}
            className="grid min-h-8 min-w-8 place-items-center rounded text-[var(--ad-red-text)]"
            onClick={() => onRevoke(bundle)}
            type="button"
          >
            <X className="h-3.5 w-3.5" />
          </button>
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
              : t("No override is recorded for this capability yet; the role decides it today.")}
          </p>
          <p className="mt-1 text-[var(--ad-text)]">{outcome(draft, alreadyEffective, existingOverride, t)}</p>
        </>
      ) : null}
    </div>
  );
}

/**
 * INTENT: 一句话说清「点下去之后这个人多了/少了什么」。clear 是最容易误解的一个——
 * 它不是「收回权限」，是「删掉覆盖、把决定权还给角色」，结果取决于角色本身给不给。
 */
function outcome(
  draft: PermissionDraft,
  alreadyEffective: boolean | null,
  existingOverride: AccessPermissionOverride | null,
  t: (key: string, values?: Record<string, string | number>) => string,
) {
  if (draft.effect === "clear") {
    return existingOverride
      ? t("Applying this removes the override and hands the decision back to the role.")
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

function userTableRows(
  users: readonly AccessUserListItem[],
  canChangeStatus: boolean,
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
        id,
        format.display(user.email),
        format.display(user.displayName),
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
                endpoint: `/api/v2/admin/users/${id}/status`,
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
  search = false,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  search?: boolean;
  value: string;
}) {
  // label 在接收方过 t()，一处修好覆盖全部调用点（搜索框、权限用户 ID、权限键…）。
  const { t } = useAdminI18n();
  return (
    <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">
      {t(label)}
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
    <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">
      {t(label)}
      <select
        className="min-h-11 rounded-md border bg-[var(--ad-surface)] px-3 text-sm"
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
