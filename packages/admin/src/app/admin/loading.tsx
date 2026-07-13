export default function AdminLoading() {
  return (
    <main aria-busy="true" aria-label="Loading Admin workspace" className="min-h-screen bg-[var(--ad-canvas)] text-[var(--ad-ink)]">
      <div className="flex min-h-screen">
        <aside className="hidden w-[248px] shrink-0 border-r border-[var(--ad-border)] bg-[var(--ad-surface)] xl:block" />
        <section className="min-w-0 flex-1 p-4 md:p-6">
          <div className="h-14 animate-pulse rounded-lg bg-black/[0.04]" />
          <div className="mt-5 h-64 animate-pulse rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]" />
        </section>
      </div>
    </main>
  );
}
