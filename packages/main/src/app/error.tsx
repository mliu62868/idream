"use client";

import Link from "next/link";
import { RotateCcw } from "lucide-react";
import { useEffect } from "react";

export default function ErrorPage({
  error,
  unstable_retry,
}: Readonly<{
  error: Error & { digest?: string };
  unstable_retry: () => void;
}>) {
  useEffect(() => {
    console.error("Main route render failed", {
      digest: error.digest,
      error,
    });
  }, [error]);

  return (
    <main className="grid min-h-screen place-items-center bg-[rgb(13,13,13)] px-4 text-white">
      <section className="max-w-xl text-center" role="alert">
        <p className="text-[12px] font-black uppercase text-[rgb(253,95,194)]">
          Temporary problem
        </p>
        <h1 className="mt-4 text-[40px] font-black uppercase leading-none md:text-[60px]">
          This page could not load
        </h1>
        <p className="mt-5 text-[15px] font-medium leading-7 text-[rgb(170,170,170)]">
          Your account data was not replaced with placeholders. Retry the
          authoritative request, or return to Explore.
        </p>
        {error.digest ? (
          <p className="mt-3 font-mono text-[11px] text-white/45">
            Reference: {error.digest}
          </p>
        ) : null}
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <button
            className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-white px-5 text-[14px] font-bold text-[rgb(13,13,13)]"
            onClick={() => unstable_retry()}
            type="button"
          >
            <RotateCcw className="h-4 w-4" />
            Try again
          </button>
          <Link
            className="inline-flex h-11 items-center justify-center rounded-full bg-[rgb(46,46,46)] px-5 text-[14px] font-bold text-white"
            href="/"
          >
            Back to Explore
          </Link>
        </div>
      </section>
    </main>
  );
}
