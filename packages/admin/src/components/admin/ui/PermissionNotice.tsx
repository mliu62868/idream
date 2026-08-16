"use client";
import type { AdminPermissionKey } from "@idream/shared/admin/permissions";
import { useAdminI18n } from "@/components/admin/i18n";
import { permissionLabel } from "./permission-copy";

// SPEC: 「这块你只能看，不能改」的统一提示：说清缺的是哪个能力、该找谁。
// INTENT: 各处以前各写一句「只读 · 尚未授予 <权限码>」。运营从权限码里读不出自己少了什么，
//         也读不出下一步；原始码留在 title 上，工程问起来还找得到。
export function PermissionNotice({ permission }: { permission: AdminPermissionKey }) {
  const { t } = useAdminI18n();
  return (
    <strong className="font-semibold text-[var(--ad-text-muted)]" title={permission}>
      {t("{capability} is unavailable — ask an admin owner to grant it.", {
        capability: t(permissionLabel(permission)),
      })}
    </strong>
  );
}
