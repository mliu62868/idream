"use client";

import { useState } from "react";
import { Loader2, LogIn, ShieldCheck, UserCog } from "lucide-react";
import type { DevAdminAccountHint } from "@/server/admin/dev-login-accounts";

type AdminDevLoginProps = {
  accounts: DevAdminAccountHint[];
  // 已登录但角色无后台权限时传入，用于提示 + 登出切换账号。
  actor: { id: string; role: string } | null;
};

export function AdminDevLogin({ accounts, actor }: AdminDevLoginProps) {
  const [username, setUsername] = useState(accounts[0]?.username ?? "");
  const [password, setPassword] = useState(accounts[0]?.password ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/admin-auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const payload = (await response.json()) as
        | { ok: true }
        | { ok: false; error?: { message?: string } };
      if (!response.ok || !payload.ok) {
        setError(
          (!payload.ok && payload.error?.message) || "登录失败，请检查账号密码",
        );
        return;
      }
      window.location.reload();
    } catch {
      setError("网络错误，请重试");
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/admin-auth/logout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ includeUserSession: true }),
      });
      if (!response.ok) {
        setError("退出失败，请重试");
        return;
      }
      window.location.reload();
    } catch {
      setError("网络错误，请重试");
    } finally {
      setBusy(false);
    }
  }

  function fill(account: DevAdminAccountHint) {
    setUsername(account.username);
    setPassword(account.password);
    setError(null);
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--ad-canvas)] px-6 py-10 text-[var(--ad-ink)]">
      <div className="rounded-lg w-full max-w-sm border border-[var(--ad-border)] bg-[var(--ad-surface)] p-6">
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-5 w-5 text-[var(--ad-green-text)]" />
          <h1 className="text-lg font-semibold">后台登录</h1>
          <span className="ml-auto rounded bg-[var(--ad-yellow-bg)] px-2 py-0.5 text-[10px] font-medium text-[var(--ad-yellow-text)]">
            DEV ONLY
          </span>
        </div>

        {actor ? (
          <div className="mt-3 rounded border border-[var(--ad-yellow-text)]/20 bg-[var(--ad-yellow-bg)] p-3 text-xs text-[var(--ad-yellow-text)]">
            当前登录角色 <span className="font-semibold">{actor.role}</span>{" "}
            无后台权限，请换内部角色账号。
          </div>
        ) : (
          <p className="mt-2 text-sm text-[var(--ad-text-muted)]">
            内置开发账号，仅本地可用。
          </p>
        )}

        <form onSubmit={submit} className="mt-4 space-y-3">
          <label className="block text-xs text-[var(--ad-text-muted)]">
            账号
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              className="rounded-md mt-1 w-full border border-[var(--ad-border)] bg-[var(--ad-canvas)] px-3 py-2 text-sm text-[var(--ad-ink)] outline-none focus:border-[var(--ad-ink)]"
            />
          </label>
          <label className="block text-xs text-[var(--ad-text-muted)]">
            密码
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              className="rounded-md mt-1 w-full border border-[var(--ad-border)] bg-[var(--ad-canvas)] px-3 py-2 text-sm text-[var(--ad-ink)] outline-none focus:border-[var(--ad-ink)]"
            />
          </label>

          {error && <p className="text-xs text-[var(--ad-red-text)]">{error}</p>}

          <button
            type="submit"
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 bg-[var(--ad-ink)] py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <LogIn className="h-4 w-4" />
            )}
            登录
          </button>
        </form>

        <div className="mt-5 border-t border-[var(--ad-border)] pt-4">
          <p className="mb-2 text-[11px] uppercase tracking-wide text-[var(--ad-text-muted)]">
            快捷账号
          </p>
          <div className="space-y-2">
            {accounts.map((account) => (
              <button
                key={account.username}
                type="button"
                onClick={() => fill(account)}
                className="rounded-lg flex w-full items-center gap-2 border border-[var(--ad-border)] px-3 py-2 text-left text-xs text-[var(--ad-text)] hover:border-[var(--ad-ink)]"
              >
                <UserCog className="h-4 w-4 shrink-0 text-[var(--ad-text-muted)]" />
                <span className="font-medium text-[var(--ad-ink)]">{account.username}</span>
                <span className="text-[var(--ad-text-muted)]">/ {account.password}</span>
                <span className="ml-auto text-[var(--ad-text-muted)]">{account.label}</span>
              </button>
            ))}
          </div>
        </div>

        {actor && (
          <button
            type="button"
            onClick={logout}
            disabled={busy}
            className="rounded-lg mt-4 w-full border border-[var(--ad-border)] py-2 text-xs text-[var(--ad-text-muted)] hover:border-[var(--ad-ink)] disabled:opacity-60"
          >
            退出当前前台登录
          </button>
        )}
      </div>
    </main>
  );
}
