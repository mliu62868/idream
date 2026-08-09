import { ShieldAlert } from "lucide-react";
import { AdminText } from "@/components/admin/i18n";

// SPEC: 名单页与详情页共用同一块拒绝态，只有权限键不同。
export function permissionDenied(label: string) {
  return (
    <section
      aria-labelledby="permission-title"
      className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-8"
    >
      <ShieldAlert className="h-6 w-6 text-[var(--ad-text-muted)]" />
      <h2 className="mt-4 text-lg font-semibold" id="permission-title">
        <AdminText text="No permission" />
      </h2>
      <p className="mt-2 text-sm text-[var(--ad-text-muted)]">
        <AdminText text="Your effective grants do not include" /> {label}
        <AdminText text=". Ask an administrator for the matching scoped permission." />
      </p>
    </section>
  );
}
