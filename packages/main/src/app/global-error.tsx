"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  unstable_retry,
}: Readonly<{
  error: Error & { digest?: string };
  unstable_retry: () => void;
}>) {
  useEffect(() => {
    console.error("Main application shell failed", {
      digest: error.digest,
      error,
    });
  }, [error]);

  return (
    <html lang="en" className="dark h-full">
      <body className="grid min-h-full place-items-center bg-black px-4 font-sans text-white">
        <title>Temporary problem | ourdream.ai</title>
        <main className="max-w-xl text-center" role="alert">
          <p className="text-xs font-black uppercase text-pink-400">
            Application unavailable
          </p>
          <h1 className="mt-4 text-4xl font-black uppercase">
            We could not open Ourdream
          </h1>
          <p className="mt-5 text-sm leading-7 text-white/65">
            Nothing was substituted or discarded. Retry the application shell
            to reconnect to the current data authority.
          </p>
          {error.digest ? (
            <p className="mt-3 font-mono text-xs text-white/45">
              Reference: {error.digest}
            </p>
          ) : null}
          <button
            className="mt-8 rounded-full bg-white px-5 py-3 text-sm font-bold text-black"
            onClick={() => unstable_retry()}
            type="button"
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
