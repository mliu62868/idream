"use client";

import type { AdminPermissionKey } from "@idream/shared/admin/permissions";
import { AdminConsoleClient } from "@/components/admin/AdminConsoleClient";
import type { AdminShellPreferences } from "@/components/admin/shell-preferences";
import type { AdminShellSignals } from "@/components/admin/shell-signals";

type AdminActor = {
  id: string;
  role: string;
};

type AdminConsoleClientOnlyProps = {
  actor: AdminActor | null;
  initialSection: string;
  initialAccess: boolean;
  initialPermissions: AdminPermissionKey[];
  preferences: AdminShellPreferences;
  shellSignals: AdminShellSignals;
  devLogout?: boolean;
};

export function AdminConsoleClientOnly(props: AdminConsoleClientOnlyProps) {
  return <AdminConsoleClient {...props} />;
}
