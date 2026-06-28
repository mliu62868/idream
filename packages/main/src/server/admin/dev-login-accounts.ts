// SPEC: 内置的 dev-only 后台账号清单（用户名+密码 → 已 seed 的内部角色用户）。
// INTENT: 提供最简单的本地后台登录方式，不入库、纯硬编码，方便测试与开发。
// INVARIANTS: userId 必须对应 prisma seed 出来的内部角色用户；password 仅供本地，禁止用于生产。
// 纯数据模块——无 prisma/env 依赖，可同时被 server 与 client(登录表单) 引用。
import type { ActorRole } from "@/server/lib/auth";

export type DevAdminAccount = {
  username: string;
  password: string;
  userId: string;
  label: string;
  role: ActorRole;
};

export const DEV_ADMIN_ACCOUNTS: readonly DevAdminAccount[] = [
  {
    username: "admin",
    password: "admin123",
    userId: "seed-admin-user",
    label: "Admin · 全部权限",
    role: "admin",
  },
  {
    username: "support",
    password: "support123",
    userId: "seed-support-user",
    label: "Support · 只读 + 工单",
    role: "support",
  },
];

// 给登录表单展示用的公开子集（dev-only，密码明文提示是刻意的便利）。
export const DEV_ADMIN_ACCOUNT_HINTS = DEV_ADMIN_ACCOUNTS.map((account) => ({
  username: account.username,
  password: account.password,
  label: account.label,
  role: account.role,
}));

export type DevAdminAccountHint = (typeof DEV_ADMIN_ACCOUNT_HINTS)[number];
