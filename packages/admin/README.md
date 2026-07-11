# @idream/admin

iDream 后台控制台，独立部署的内部控制面服务（端口 3001）。Admin 只编译本包 UI 与 `@idream/shared` 契约；身份、查询和命令通过 fail-closed HTTP BFF 交给 main authority。

## 本地启动

```bash
# 1. 种子化开发库（内置账号映射到这些 seed 用户，首次必须执行）
cd packages/main && npm run db:seed

# 2. 启动后台（仓库根目录）
bun run dev:admin     # http://localhost:3001/admin
```

## 登录

后台用与普通用户**隔离的登录态**（cookie `idream_admin_session`，独立于前台的 `idream_session`）。

**开发环境**（`APP_ENV != production`）：打开 `/admin` 会出现登录框，内置两个账号，点快捷按钮即可填充：

| 账号 | 密码 | 角色 | 权限 |
|------|------|------|------|
| `admin` | `admin123` | admin | 全部 |
| `support` | `support123` | support | 只读 + 工单 |

开发账号由 main authority 的 `/api/admin-auth/*` 契约返回；Admin 不导入认证实现。登录态有效期 12h；控制台右上角「退出」可切换账号。

> 这些密码是本地开发便利，**仅非 production 生效**，生产环境登录框与接口（`/api/admin-auth/*`）整体禁用。

**生产环境**：无内置登录，需带有内部角色（admin/moderator/support/ops/analyst）的有效 session；非内部角色访问 `/admin` 显示 “Admin access denied”。

## 权限模型

权限键与角色默认映射由 `@idream/shared/admin/permissions` 定义，main authority 解析最终 effective permissions；进入控制台要求 `dashboard.read`。

## 验证

```bash
cd packages/admin && bun run check && bun run test
```
