"use client";
import type { ReactNode } from "react";
import { adminDateLocale, translateAdmin, type AdminLocale, useAdminI18n } from "@/components/admin/i18n";

// SPEC: 列表单元格的取值与格式化只有这一份。
// INTENT: text / display / date 三件套在 features 下被逐字复制了 12 份，日期还长出四种口径：
//         裸 toLocaleString()（10 处）、裸 toLocaleTimeString()（8 处）、显式 locale、
//         adminDateLocale。前两种跟浏览器 locale 走 —— 中文界面里显示的是英文日期。
// INVARIANT: 这里的每个时间函数都过 adminDateLocale(locale)。不要再出现裸 toLocale*。

/** 只有字符串才是字符串；其余一律空串，交给上层决定怎么显示缺失。 */
export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// SPEC: 未知形状的值怎么显示 —— 空是破折号、标量原样、其余折成可看全的 JSON。
// INTENT: 12 份副本里有 4 种做法，最差的一种把对象直接显示成 "—"，等于把数据藏了。
//         这里取并集里信息量最大的那一种：对象也要能看见，只是折起来。
export function displayValue(value: unknown, labels: { yes: string; no: string }): ReactNode {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? labels.yes : labels.no;
  if (typeof value === "string" || typeof value === "number") return String(value);
  return <code className="block max-w-72 truncate text-xs" title={JSON.stringify(value)}>{JSON.stringify(value)}</code>;
}

function parse(value: unknown) {
  const raw = typeof value === "number" ? value : text(value);
  if (raw === "") return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 只到日 —— 列表里的"创建于哪天"。 */
export function formatDate(value: unknown, locale: AdminLocale): string {
  return parse(value)?.toLocaleDateString(adminDateLocale(locale), { dateStyle: "medium" }) ?? "—";
}

/** 日 + 时分 —— 运营需要对齐事件先后顺序时的默认口径。 */
export function formatDateTime(value: unknown, locale: AdminLocale): string {
  return parse(value)?.toLocaleString(adminDateLocale(locale), { dateStyle: "medium", timeStyle: "short" }) ?? "—";
}

/** 只到秒 —— "刚刚刷新于 …" 这种同一天内的时刻。 */
export function formatTime(value: unknown, locale: AdminLocale): string {
  return parse(value)?.toLocaleTimeString(adminDateLocale(locale), { timeStyle: "medium" }) ?? "—";
}

// SPEC: 相对时间取最大的整数单位，只给一位（"3 天"而不是"3 天 4 小时"）。
// INTENT: 队列里唯一在变的量是积压了多久；绝对时间戳要读者自己做减法。
export function formatRelativeTime(value: unknown, referenceTime: unknown, locale: AdminLocale): string {
  const date = parse(value);
  const reference = parse(referenceTime);
  if (!date || !reference) return "—";
  const deltaMs = date.getTime() - reference.getTime();
  const format = new Intl.RelativeTimeFormat(adminDateLocale(locale) ?? "en", { numeric: "auto" });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  for (const [unit, ms] of units) {
    const amount = Math.trunc(deltaMs / ms);
    if (amount !== 0) return format.format(amount, unit);
  }
  return format.format(0, "minute");
}

export function formatMoney(amountCents: number, currency: string, locale: AdminLocale): string {
  try {
    return new Intl.NumberFormat(adminDateLocale(locale), { style: "currency", currency: currency || "USD" })
      .format(amountCents / 100);
  } catch {
    // 后端偶尔给出非 ISO 的币种码；宁可显示原始数值，也不要整行崩掉。
    return `${amountCents} ${currency || "cents"}`;
  }
}

export function formatCount(value: number, locale: AdminLocale): string {
  return value.toLocaleString(adminDateLocale(locale));
}

// INTENT: 不吃 locale —— 输出的是 m/s 单位符号，两种语言下都一样。负数 clamp 到 0：
//         被它取代的两份手写副本没有 clamp，会把 -65s 渲染成 "-2m -5s"。
export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  return minutes > 0 ? `${minutes}m ${totalSeconds % 60}s` : `${totalSeconds}s`;
}

// SPEC: 梦币金额。核心是千分位 + 正负号约定；单位走既有的 "{cost} DC" 词条，
//       中文界面显示"梦币"而不是 "DC"。
// INTENT: 之前是裸字符串拼接（`${x} DC` / String(x) / display(x)），无千分位、无正负号，
//         单位一会儿 "DC" 一会儿 "Dreamcoins"。signed 留给账本流水（有借有贷，必须一眼
//         看出正负）；余额与成本这类只会是正数的场景不加号，免得读起来像变化量。
//         unit 可关 —— 列头已经写着 Dreamcoins 时，每个单元格再缀一遍是噪音。
export function formatDreamcoins(
  amount: number,
  locale: AdminLocale,
  options?: { signed?: boolean; unit?: boolean },
): string {
  const cost = new Intl.NumberFormat(adminDateLocale(locale), {
    signDisplay: options?.signed ? "exceptZero" : "auto",
  }).format(amount);
  return options?.unit === false ? cost : translateAdmin(locale, "{cost} DC", { cost });
}

/** 组件里用这个：locale 已绑好，调用点不必再记得传。 */
export function useAdminFormat() {
  const { locale, t } = useAdminI18n();
  return {
    text,
    display: (value: unknown) => displayValue(value, { yes: t("yes"), no: t("no") }),
    date: (value: unknown) => formatDate(value, locale),
    dateTime: (value: unknown) => formatDateTime(value, locale),
    time: (value: unknown) => formatTime(value, locale),
    relativeTime: (value: unknown, referenceTime: unknown) => formatRelativeTime(value, referenceTime, locale),
    money: (amountCents: number, currency: string) => formatMoney(amountCents, currency, locale),
    count: (value: number) => formatCount(value, locale),
    duration: formatDuration,
    dreamcoins: (amount: number, options?: { signed?: boolean; unit?: boolean }) =>
      formatDreamcoins(amount, locale, options),
  };
}
