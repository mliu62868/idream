"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  parseAgeVerificationSessionResponse,
  parseAgeVerificationStatusResponse,
  type PublicAgeVerificationStatus,
} from "@/lib/public-api-contracts";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// SPEC: 被年龄验证挡住的用户必须能自己重新发起验证。
// INTENT: `requireAgeVerified` 守着约 20 个操作，判据是 age_verifications 最新一行的状态。
//   在这个面板之前，站内没有任何地方调用 POST /age-verification/sessions——只要有一行落到
//   pending/failed/expired，用户就被永久锁死且无法自救，只能等运营手工改库。一道进得去、
//   出不来的门不是门。这里只补「发起/重试」这一个缺口，状态判定仍由服务端唯一负责。
export const AGE_VERIFICATION_COPY: Record<
  Exclude<PublicAgeVerificationStatus, "not_required">,
  { heading: string; body: string; action: string }
> = {
  verified: {
    heading: "Age verified",
    body: "Age-restricted features are available on this account.",
    action: "Verify again",
  },
  required: {
    heading: "Age verification required",
    body: "Age-restricted features stay locked until this account completes verification.",
    action: "Start verification",
  },
  pending: {
    heading: "Verification in progress",
    body: "The provider has not returned a final result yet. Check again, or start over if you never reached the provider.",
    action: "Start over",
  },
  failed: {
    heading: "Verification did not pass",
    body: "Age-restricted features are locked until a new verification succeeds. You can start another attempt now.",
    action: "Try again",
  },
  expired: {
    heading: "Verification expired",
    body: "Age-restricted features are locked until this account verifies again.",
    action: "Verify again",
  },
};

const OWNER_CONFIRM_RETRIES = 10;
const OWNER_CONFIRM_RETRY_MS = 300;

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

async function readData<T>(response: Response, parse: (payload: unknown) => T) {
  const payload: unknown = await response.json();
  if (!response.ok) {
    const message =
      typeof (payload as { error?: { message?: unknown } })?.error?.message === "string"
        ? ((payload as { error: { message: string } }).error.message)
        : "The request could not be completed. Try again.";
    throw new Error(message);
  }
  return parse(payload);
}

export function AccountAgeVerification({
  ownerId,
  fetcher = fetch,
  redirect = (url: string) => window.location.assign(url),
}: Readonly<{ ownerId: string; fetcher?: Fetcher; redirect?: (url: string) => void }>) {
  const [status, setStatus] = useState<PublicAgeVerificationStatus | null>(null);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const alive = useRef(false);

  const load = useCallback(() => {
    const readStatus = async () => {
      const response = await fetcher("/api/v1/age-verification/status", {
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      return readData(response, parseAgeVerificationStatusResponse);
    };
    return readStatus().then((data) => {
      if (!alive.current) return true;
      setStatus(data.status);
      setMessage("");
      return true;
    }).catch((error: unknown) => {
      if (!alive.current) return true;
      // Profile 每次刷新账号身份都会先把已确认的 owner 清空，这期间 fetchForOwner 抛
      // AbortError。那是生命周期信号不是失败：既不该报给用户，也不能就此放弃——
      // 确认结果存在 ref 里，不会触发重渲染，等不到「新 fetcher」，只能自己再问一次。
      if (isAbort(error)) return false;
      setMessage(
        error instanceof Error
          ? error.message
          : "Age verification status could not be checked. Reload and try again.",
      );
      return true;
    });
  }, [fetcher]);

  useEffect(() => {
    alive.current = true;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () => {
      void load().then((settled) => {
        if (settled || !alive.current || (attempt += 1) > OWNER_CONFIRM_RETRIES) return;
        timer = setTimeout(ask, OWNER_CONFIRM_RETRY_MS);
      });
    };
    ask();
    return () => {
      alive.current = false;
      if (timer) clearTimeout(timer);
    };
  }, [load, ownerId]);

  async function start() {
    if (pending) return;
    setPending(true);
    setMessage("");
    try {
      const response = await fetcher("/api/v1/age-verification/sessions", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({}),
      });
      const data = await readData(response, parseAgeVerificationSessionResponse);
      if (data.url) {
        redirect(data.url);
        return;
      }
      if (!alive.current) return;
      setStatus(data.verification.status);
      setMessage(
        data.verification.status === "verified" || data.verification.status === "not_required"
          ? "Verification is complete. Age-restricted features are available again."
          : "Verification started. This page shows the result once the provider reports it.",
      );
    } catch (error) {
      if (!alive.current || isAbort(error)) return;
      setMessage(
        error instanceof Error
          ? error.message
          : "Verification could not be started. Try again in a moment.",
      );
    } finally {
      if (alive.current) setPending(false);
    }
  }

  if (status === null && !message) return null;
  // 无记录时服务端按 not_required 放行，此时没有任何要用户处理的事。
  if (status === "not_required" && !message) return null;
  const copy = status && status !== "not_required" ? AGE_VERIFICATION_COPY[status] : null;

  return (
    <div
      className="mt-5 border-t border-white/10 pt-5"
      data-testid="profile-age-verification"
    >
      <h3 className="text-base font-bold">{copy?.heading ?? "Age verification"}</h3>
      {copy ? <p className="mt-2 text-sm leading-6 text-white/70">{copy.body}</p> : null}
      {status !== "verified" ? (
        <button
          className="mt-3 rounded-full bg-pink-600 px-5 py-3 text-sm font-bold disabled:opacity-40"
          data-testid="profile-age-verification-start"
          disabled={pending}
          onClick={() => void start()}
          type="button"
        >
          {pending ? "Working…" : (copy?.action ?? "Start verification")}
        </button>
      ) : null}
      {message ? (
        <p className="mt-3 text-sm leading-6" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
