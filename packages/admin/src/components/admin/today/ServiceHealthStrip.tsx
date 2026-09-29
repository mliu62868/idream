"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { opsHealthResponseSchema, type OpsHealth } from "@idream/shared/admin";
import { useAdminI18n } from "@/components/admin/i18n";
import { adminV2Request } from "@/lib/admin-v2-api";

// SPEC: Today 首屏的一行服务状态：聊天、图片、视频各自 正常 / 异常 / 停机。
// INTENT: 聊天模型曾停机四天无人察觉 —— 事故只由生图失败自动生成，首页不显示任何服务信号。
//         这一行只回答「产品现在能不能用」，细节跳到各自的诊断页。
// INVARIANT: 读不到（无权限或接口失败）就不渲染，不拿「未知」冒充「正常」，也不挡住工作队列。
const REFRESH_MS = 60_000;
const SERVICE_LINK: Record<OpsHealth["services"][number]["key"], string> = {
  chat: "/admin/ops/chat",
  image: "/admin/ops/providers?view=backends",
  video: "/admin/ops/providers?view=backends",
};
const SERVICE_LABEL: Record<OpsHealth["services"][number]["key"], string> = {
  chat: "Chat service",
  image: "Image generation",
  video: "Video generation",
};

export function ServiceHealthStrip() {
  const { t } = useAdminI18n();
  const [health, setHealth] = useState<OpsHealth | null>(null);

  useEffect(() => {
    let active = true;
    const load = () => {
      void adminV2Request("/api/v2/admin/ops/health", { schema: opsHealthResponseSchema })
        .then((data) => { if (active) setHealth(data); })
        .catch(() => { if (active) setHealth(null); });
    };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  if (!health) return null;
  const broken = health.services.filter((service) => service.state !== "ok");
  return (
    <section
      aria-label={t("Service health")}
      className={`flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border px-4 py-3 text-sm ${broken.length ? "border-[var(--ad-red-text)] bg-[var(--ad-red-bg)]" : "border-[var(--ad-border)] bg-[var(--ad-surface)]"}`}
      data-testid="service-health"
      role={broken.length ? "alert" : "status"}
    >
      <strong className="font-semibold">{broken.length ? t("Service problem") : t("All services up")}</strong>
      {health.services.map((service) => (
        <Link className="inline-flex items-center gap-2 underline-offset-2 hover:underline" href={SERVICE_LINK[service.key]} key={service.key} title={service.detail ?? undefined}>
          <span aria-hidden className={`h-2 w-2 rounded-full ${service.state === "ok" ? "bg-[var(--ad-green-text)]" : service.state === "degraded" ? "bg-[var(--ad-yellow-text)]" : "bg-[var(--ad-red-text)]"}`} />
          <span>{t(SERVICE_LABEL[service.key])}</span>
          <span className={service.state === "ok" ? "text-[var(--ad-text-muted)]" : "font-semibold text-[var(--ad-red-text)]"}>
            {service.state === "down"
              ? t("Down")
              : service.state === "degraded"
                ? t("{failures} of {attempts} failed in the last hour", { failures: service.failuresLastHour, attempts: service.attemptsLastHour })
                : service.attemptsLastHour > 0
                  ? t("{attempts} in the last hour", { attempts: service.attemptsLastHour })
                  : t("Up")}
          </span>
        </Link>
      ))}
    </section>
  );
}
