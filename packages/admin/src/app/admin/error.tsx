"use client";

export default function AdminError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="grid min-h-screen place-items-center bg-[var(--ad-canvas)] p-6 text-[var(--ad-ink)]">
      <section className="max-w-lg rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-6" role="alert">
        <h1 className="text-xl font-semibold">Admin workspace failed to load</h1>
        <p className="mt-2 text-sm text-[var(--ad-text-muted)]">{error.message || "The workspace hit an unexpected rendering error."}</p>
        <button className="mt-5 min-h-11 rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white" onClick={reset} type="button">Try again</button>
      </section>
    </main>
  );
}
