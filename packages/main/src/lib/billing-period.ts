export type BillingPeriod = "monthly" | "yearly";

export function billingPeriodEnd(
  startsAt: Date,
  billingPeriod: BillingPeriod,
) {
  const months = billingPeriod === "yearly" ? 12 : 1;
  const year = startsAt.getUTCFullYear();
  const month = startsAt.getUTCMonth();
  const day = startsAt.getUTCDate();
  const end = new Date(
    Date.UTC(
      year,
      month + months,
      1,
      startsAt.getUTCHours(),
      startsAt.getUTCMinutes(),
      startsAt.getUTCSeconds(),
      startsAt.getUTCMilliseconds(),
    ),
  );
  const lastDayOfTargetMonth = new Date(
    Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0),
  ).getUTCDate();
  end.setUTCDate(Math.min(day, lastDayOfTargetMonth));
  return end;
}
