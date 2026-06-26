#!/usr/bin/env node
import { randomBytes } from "node:crypto";

const specs = [
  ["BETTER_AUTH_SECRET", 48],
  ["INTERNAL_TOKEN", 32],
  ["CRON_SECRET", 32],
  ["CHAT_BFF_SIGNING_SECRET", 48],
  ["PIPELINE_API_TOKEN", 32],
  ["MODERATION_API_KEY", 32],
  ["AGE_VERIFY_API_KEY", 32],
  ["AGE_VERIFY_WEBHOOK_SECRET", 32],
  ["BTCPAY_WEBHOOK_SECRET", 32],
];

for (const [key, byteLength] of specs) {
  console.log(`${key}=${randomBytes(byteLength).toString("base64url")}`);
}
