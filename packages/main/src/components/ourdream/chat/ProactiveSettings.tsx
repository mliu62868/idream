"use client";

import { useEffect, useRef, useState } from "react";

const INTERVAL_CHOICES = [
  { hours: 6, label: "Every 6 hours" },
  { hours: 12, label: "Every 12 hours" },
  { hours: 24, label: "Once a day" },
  { hours: 48, label: "Every 2 days" },
  { hours: 72, label: "Every 3 days" },
  { hours: 168, label: "Once a week" },
] as const;

type Settings = {
  enabled: boolean;
  intervalHours: number;
  nextAt: string | null;
};

function parseSettings(value: unknown): Settings {
  const record = (value ?? {}) as Record<string, unknown>;
  return {
    enabled: record.enabled === true,
    intervalHours:
      typeof record.intervalHours === "number" ? record.intervalHours : 24,
    nextAt: typeof record.nextAt === "string" ? record.nextAt : null,
  };
}

// SPEC: 角色主动来消息的节奏，默认关闭，用户随时可关。
// INTENT: 开启后第一条在一个完整周期之后到达，所以这里直接把下一次时间显示出来 ——
//         用户对"它什么时候会打扰我"应当有确定答案，而不是只看到一个开关。
export function ProactiveSettings({
  sessionId,
}: Readonly<{ sessionId: string }>) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scope = useRef(0);
  const base = `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/proactive`;

  useEffect(() => {
    const epoch = ++scope.current;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(base, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("unavailable");
        const body = (await response.json()) as unknown;
        if (scope.current !== epoch) return;
        setSettings(parseSettings(body));
      } catch (cause) {
        if (scope.current !== epoch) return;
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError("Couldn't load check-in settings.");
      }
    })();
    return () => {
      scope.current += 1;
      controller.abort();
    };
  }, [base]);

  async function save(next: { enabled: boolean; intervalHours: number }) {
    const epoch = ++scope.current;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(base, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!response.ok) throw new Error("rejected");
      const body = (await response.json()) as unknown;
      if (scope.current !== epoch) return;
      setSettings(parseSettings(body));
    } catch {
      if (scope.current === epoch) {
        setError("Couldn't save that. Try again.");
      }
    } finally {
      if (scope.current === epoch) setPending(false);
    }
  }

  if (!settings) {
    return error ? (
      <p className="mt-4 text-[12px] leading-4 text-[rgb(255,138,128)]" role="status">
        {error}
      </p>
    ) : null;
  }

  const nextAt = settings.nextAt ? new Date(settings.nextAt) : null;

  return (
    <section className="mt-4">
      <div className="my-4 h-px bg-[rgb(36,36,36)]" />
      <h3 className="mb-1 text-[12px] font-bold uppercase tracking-wide text-[rgb(170,170,170)]">
        Check-ins
      </h3>
      <label className="flex items-center gap-3 py-1 text-[13px] font-semibold text-white">
        <input
          checked={settings.enabled}
          className="h-4 w-4 accent-[rgb(255,64,180)]"
          disabled={pending}
          id={`proactive-enabled-${sessionId}`}
          onChange={(event) =>
            void save({
              enabled: event.target.checked,
              intervalHours: settings.intervalHours,
            })
          }
          type="checkbox"
        />
        Let this character message me first
      </label>
      <p className="mt-1 text-[12px] leading-4 text-[rgb(114,113,112)]">
        {settings.enabled
          ? "They start a conversation on this schedule when you have not written for a while."
          : "Off: this character only replies to you."}
      </p>

      {settings.enabled ? (
        <>
          <select
            aria-label="Check-in frequency"
            className="mt-3 w-full rounded-xl border border-white/10 bg-[rgb(28,28,28)] p-3 text-[13px] text-white disabled:opacity-50"
            disabled={pending}
            id={`proactive-interval-${sessionId}`}
            onChange={(event) =>
              void save({
                enabled: true,
                intervalHours: Number(event.target.value),
              })
            }
            value={settings.intervalHours}
          >
            {INTERVAL_CHOICES.map((choice) => (
              <option key={choice.hours} value={choice.hours}>
                {choice.label}
              </option>
            ))}
          </select>
          {nextAt ? (
            <p className="mt-2 text-[12px] leading-4 text-[rgb(114,113,112)]">
              Next check-in after {nextAt.toLocaleString()}.
            </p>
          ) : null}
        </>
      ) : null}

      {error ? (
        <p
          className="mt-2 text-[12px] leading-4 text-[rgb(255,138,128)]"
          role="status"
        >
          {error}
        </p>
      ) : null}
    </section>
  );
}
