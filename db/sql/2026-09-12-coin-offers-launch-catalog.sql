-- Dreamcoin 充值目录首次上架。
--
-- 为什么需要这份脚本：coin_offers 一行都没有，前台 Dreamcoin Store 显示
-- "No dreamcoin offers are available right now"。dreamcoin 是图片(5)/视频(100)/语音(2)
-- 的唯一消耗品，套餐只在购买时一次性赠币，币用完后用户没有任何补充途径。
--
-- 定价依据：换算率必须差于最差的套餐，否则充值会侵蚀套餐。
--   现有套餐 —— Premium 月付 1,500 币 / $19.99 = 75 币/$（最差）
--               Deluxe  年付 72,000 币 / $299.90 = 240 币/$（最好）
--   本目录   —— 50 / 53 / 58 / 63 币/$，全部低于 75，且按量递增给好处。
--
-- 这些行等价于后台「创建草稿 → 发布」之后的状态：version=1、status=published、
-- publishedAt 已写。审计行一并写入，保持配置变更可追溯。
-- 幂等：重复执行不会产生第二份目录。

BEGIN;

INSERT INTO "coin_offers" (
  "id", "offerKey", "version", "name", "dreamcoins", "priceCents", "currency",
  "eligibility", "terms", "status", "publishedAt", "createdAt", "updatedAt"
)
SELECT
  v."id", v."offerKey", 1, v."name", v."dreamcoins", v."priceCents", 'usd',
  'all', t."terms", 'published', now(), now(), now()
FROM (VALUES
  ('coin_offer_starter_500',  'coins-starter-500',  'Starter · 500 dreamcoins',   500,   999),
  ('coin_offer_regular_1600', 'coins-regular-1600', 'Regular · 1,600 dreamcoins', 1600,  2999),
  ('coin_offer_plus_3500',    'coins-plus-3500',    'Plus · 3,500 dreamcoins',    3500,  5999),
  ('coin_offer_max_7500',     'coins-max-7500',     'Max · 7,500 dreamcoins',     7500, 11999)
) AS v("id", "offerKey", "name", "dreamcoins", "priceCents")
CROSS JOIN (VALUES (
  'One-time prepaid purchase. Dreamcoins are credited once the payment is confirmed and stay available while your account is active, including after a plan ends. No subscription and no automatic renewal. A failed or cancelled payment grants nothing and is not charged; refunds follow the published refund policy.'
)) AS t("terms")
WHERE NOT EXISTS (
  SELECT 1 FROM "coin_offers" existing WHERE existing."offerKey" = v."offerKey"
);

INSERT INTO "admin_audit_logs" ("id", "actorId", "actorRole", "action", "targetType", "targetId", "reason", "after", "createdAt")
SELECT
  'audit_' || o."id",
  'system:coin-offer-launch-catalog',
  'system',
  'config.coin_offer.publish',
  'coin_offer',
  o."id",
  'Launch catalog: the coin store had no purchasable offers, so dreamcoins could not be topped up.',
  to_jsonb(o) - 'updatedAt',
  now()
FROM "coin_offers" o
WHERE o."offerKey" IN ('coins-starter-500', 'coins-regular-1600', 'coins-plus-3500', 'coins-max-7500')
  AND NOT EXISTS (
    SELECT 1 FROM "admin_audit_logs" a WHERE a."id" = 'audit_' || o."id"
  );

COMMIT;
