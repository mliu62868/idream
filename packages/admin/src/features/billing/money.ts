/**
 * SPEC: 钱的显示口径。梦币与法币各一个入口，钱与增长簇（billing / access / promo）共用。
 *
 * INTENT: 之前每张表各写各的——`String(user.dreamcoins)`、`display(row.delta)`、
 * `JSON.stringify(row.reward)`。同一个数字在三个页面长得不一样，四位数没有千分位，
 * 而账本的 delta 是有正负的：`-1500` 和 `1500` 在一列里挨着，运营得逐个字符读。
 * 财务口径不该由每个组件自己发明。
 *
 * MIGRATION: 通用的 text/display/date 三件套正在 `ui/format.ts` 统一，与这里无关——
 * 那是「未知值怎么占位」，这里是「钱怎么写」。合并时不要把两者揉成一个模块。
 */

/** INVARIANT: 梦币是整数，没有小数位；`en` 分组符固定为逗号，避免跟着浏览器语言漂。 */
const DREAMCOIN_FORMAT = new Intl.NumberFormat("en", {
  maximumFractionDigits: 0,
  useGrouping: true,
});

export function dreamcoins(amount: number) {
  return Number.isFinite(amount) ? DREAMCOIN_FORMAT.format(amount) : "—";
}

/**
 * SPEC: 账本增减一律带符号，正数也要写 `+`。
 * INTENT: 「发了 1,500」和「扣了 1,500」在一列里必须一眼分得开，不能靠有没有那个短横线。
 */
export function signedDreamcoins(delta: number) {
  if (!Number.isFinite(delta)) return "—";
  return delta > 0 ? `+${dreamcoins(delta)}` : dreamcoins(delta);
}

/**
 * SPEC: provider 侧金额按 cents 存，按币种格式化。
 * INTENT: 币种是后端给的自由字符串，Intl 不认就原样把数值和币种印出来——
 * 宁可难看，也不能把 `usd` 悄悄当成默认币种显示成 $。
 */
export function fiat(amountCents: number, currency: string | null) {
  const code = (currency ?? "").trim();
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: code || "USD",
    }).format(amountCents / 100);
  } catch {
    return `${amountCents / 100} ${code}`;
  }
}
