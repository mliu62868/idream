"use client";

import dynamic from "next/dynamic";
import type { ComponentType } from "react";
import type { AdminShellSignals } from "@/components/admin/shell-signals";

type AdminActor = {
  id: string;
  role: string;
};

type AdminConsoleClientOnlyProps = {
  actor: AdminActor | null;
  initialSection: string;
  initialAccess: boolean;
  initialPermissions: string[];
  shellSignals: AdminShellSignals;
  devLogout?: boolean;
};

const AdminConsoleClientNoSsr = dynamic(
  () =>
    import("@/components/admin/AdminConsoleClient").then(
      (module) => module.AdminConsoleClient as ComponentType<AdminConsoleClientOnlyProps>,
    ),
  {
    ssr: false,
    loading: () => <AdminConsoleLoadingShell />,
  },
);

export function AdminConsoleClientOnly(props: AdminConsoleClientOnlyProps) {
  return <AdminConsoleClientNoSsr {...props} />;
}

function AdminConsoleLoadingShell() {
  return (
    <main className="min-h-screen bg-[var(--ad-canvas)] text-[var(--ad-ink)]">
      <div className="flex min-h-screen">
        <aside className="sticky top-0 hidden h-screen w-[248px] shrink-0 border-r border-[var(--ad-border)] bg-[var(--ad-surface)] md:block">
          <div className="flex h-14 items-center border-b border-[var(--ad-border)] px-5">
            <div>
              <p className="text-sm font-semibold">iDream Admin</p>
              <p className="text-[11px] text-[var(--ad-text-muted)]">loading</p>
            </div>
          </div>
          <div className="space-y-2 p-3">
            {Array.from({ length: 10 }, (_, index) => (
              <div key={index} className="h-10 rounded-md bg-black/[0.03]" />
            ))}
          </div>
        </aside>
        <section className="min-w-0 flex-1">
          <header className="sticky top-0 z-20 border-b border-[var(--ad-border)] bg-[rgba(247,246,243,0.92)] backdrop-blur">
            <div className="flex min-h-14 items-center px-4 md:px-6">
              <div>
                <h1 className="text-base font-semibold md:text-lg">Admin</h1>
                <p className="text-[11px] text-[var(--ad-text-muted)]">loading</p>
              </div>
            </div>
          </header>
          <div className="p-4 md:p-6">
            <div className="h-48 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]" />
          </div>
        </section>
      </div>
    </main>
  );
}
