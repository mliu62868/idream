import Link from "next/link";

export default function AdminNotFound() {
  return (
    <main className="grid min-h-screen place-items-center bg-[var(--ad-canvas)] p-6 text-[var(--ad-ink)]">
      <section className="max-w-md rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-6">
        <h1 className="text-xl font-semibold">未找到后台工作区</h1>
        <p className="mt-2 text-sm text-[var(--ad-text-muted)]">此路由不属于当前控制面信息架构。</p>
        <Link className="mt-5 inline-flex min-h-11 items-center rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white" href="/admin/today">返回今日工作</Link>
      </section>
    </main>
  );
}
