"use client";

import dynamic from "next/dynamic";
import type { ComponentType } from "react";

type AdminActor = {
  id: string;
  role: string;
};

type AdminConsoleClientOnlyProps = {
  actor: AdminActor | null;
  initialSection: string;
  initialAccess: boolean;
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
    <main className="min-h-screen bg-[rgb(13,13,13)] text-white">
      <div className="flex min-h-screen">
        <aside className="sticky top-0 hidden h-screen w-[248px] shrink-0 border-r border-white/10 bg-[rgb(18,18,18)] md:block">
          <div className="flex h-14 items-center border-b border-white/10 px-5">
            <div>
              <p className="text-sm font-semibold">iDream Admin</p>
              <p className="text-[11px] text-[rgb(170,170,170)]">loading</p>
            </div>
          </div>
          <div className="space-y-2 p-3">
            {Array.from({ length: 10 }, (_, index) => (
              <div key={index} className="h-10 rounded-md bg-white/[0.04]" />
            ))}
          </div>
        </aside>
        <section className="min-w-0 flex-1">
          <header className="sticky top-0 z-20 border-b border-white/10 bg-[rgba(13,13,13,0.92)] backdrop-blur">
            <div className="flex min-h-14 items-center px-4 md:px-6">
              <div>
                <h1 className="text-base font-semibold md:text-lg">Admin</h1>
                <p className="text-[11px] text-[rgb(170,170,170)]">loading</p>
              </div>
            </div>
          </header>
          <div className="p-4 md:p-6">
            <div className="h-48 border border-white/10 bg-[rgb(18,18,18)]" />
          </div>
        </section>
      </div>
    </main>
  );
}
