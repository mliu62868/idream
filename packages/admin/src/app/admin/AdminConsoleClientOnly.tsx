"use client";

import type { AdminPermissionKey } from "@idream/shared/admin/permissions";
import { AdminConsoleClient } from "@/components/admin/AdminConsoleClient";
import type { AdminShellSignals } from "@/components/admin/shell-signals";
import { ToastProvider } from "@/components/admin/ui/Toast";

type AdminActor = {
  id: string;
  role: string;
};

type AdminConsoleClientOnlyProps = {
  actor: AdminActor | null;
  initialSection: string;
  initialAccess: boolean;
  initialPermissions: AdminPermissionKey[];
  shellSignals: AdminShellSignals;
  devLogout?: boolean;
};

export function AdminConsoleClientOnly(props: AdminConsoleClientOnlyProps) {
  return (
    <ToastProvider>
      <AdminConsoleClient {...props} />
    </ToastProvider>
  );
}
