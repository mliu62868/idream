"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

// SPEC: top-bar auth state. Reads /api/v1/me on mount; shows the signed-in user
// (avatar + name + log out) when a session cookie is present, otherwise the
// Login / Join Free calls-to-action. INTENT: the header reflects real auth state
// instead of always inviting sign-up.

type AuthUser = {
  displayName: string | null;
  email: string;
  image: string | null;
};

type MeResponse = {
  data?: { user: AuthUser | null };
};

export function AuthNav() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/v1/me", { signal: controller.signal })
      .then((response) => (response.ok ? (response.json() as Promise<MeResponse>) : null))
      .then((payload) => setUser(payload?.data?.user ?? null))
      .catch(() => undefined)
      .finally(() => setLoaded(true));
    return () => controller.abort();
  }, []);

  async function logout() {
    await fetch("/api/v1/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.href = "/";
  }

  // Reserve space while resolving to avoid a Login→name layout flash.
  if (!loaded) return <div aria-hidden className="h-8 w-28" />;

  if (user) {
    const name = user.displayName ?? user.email.split("@")[0];
    return (
      <div className="flex items-center gap-2">
        <Link
          className="flex items-center gap-2 rounded-full bg-[rgb(36,36,36)] py-1 pl-1 pr-3 transition-colors hover:bg-[rgb(46,46,46)]"
          href="/profile"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[linear-gradient(0deg,#ff1cac,#fd5fc2_50%,#ff79d1)] text-[12px] font-black text-white">
            {name.slice(0, 1).toUpperCase()}
          </span>
          <span className="hidden max-w-[120px] truncate text-[12px] font-bold leading-4 text-white md:block">
            {name}
          </span>
        </Link>
        <button
          className="text-[12px] font-bold leading-4 text-[rgb(170,170,170)] transition-colors hover:text-white"
          onClick={logout}
          type="button"
        >
          Log out
        </button>
      </div>
    );
  }

  return (
    <>
      <Link
        className="hidden text-[12px] font-bold leading-4 text-white md:block"
        href="/login"
      >
        Login
      </Link>
      <Link
        className="rounded-full bg-[linear-gradient(0deg,#ff1cac,#fd5fc2_50%,#ff79d1)] px-4 py-2 text-[12px] font-bold leading-4 text-white"
        href="/signup"
      >
        Join Free
      </Link>
    </>
  );
}
