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

## 开发约定

2026-08-15–16 那轮重构确立的规矩。这些不是风格偏好，每一条背后都有一个已经发生过的运营事故或首帧缺陷；改动前先看对应文件顶部的 `SPEC:` / `INTENT:` 注释。

**列表页走平台层，不要手写 `<table>`。** `ui/DataTable`（排序、多选批量条、骨架、错误重试、sticky 表头、列宽截断）+ `ui/Pagination`（`hasPrevious` / `onPrevious` 由调用方的游标栈提供）+ `ui/FilterBar` + `ui/useUrlFilters`。空态用 `ui/EmptyState` 并区分 `kind="empty"` 与 `kind="filtered"`。别再手写「下一页」按钮——`Pagination` 的存在就是为了收掉那 9 份副本；`paginationSummary` 在拿不到 `totalCount` 时不编造总页数。行内 id 用 `ui/CopyableId`。

**格式化只走 `ui/format`。** `text` / `displayValue` / `formatDate` / `formatDateTime` / `formatTime` / `formatRelativeTime` / `formatMoney` / `formatDreamcoins` / `formatCount` / `formatDuration`，组件里用 `useAdminFormat()` 拿到已绑定 locale 的一组。**不要裸调 `toLocale*String()`**——它不吃 admin 的 locale 偏好，梦币金额还会退化成无千分位的字符串拼接。注意：存量还没迁完，`src` 下仍有几十处裸调用，且没有守卫测试拦着，所以这条靠自觉；新代码不要再添。

**状态色只有 `ui/status-tone` 一张表。** `statusTone(status)` + `STATUS_TONE_CLASS`，渲染走 `ui/StatusPill`。不要在 feature 目录里再起一张私表——合并前 `features/operations/WorkspaceUi.tsx` 里那张 4 档私表把 neutral 渲成蓝色，同一个 `active` 在 Placements 是绿的、在 Cases 是蓝的。表里只收契约里定义过、或界面真实渲染过的状态词，来源写在每组上方的注释里；查不到来源的词让它落到 neutral，别编一个色档。

**写操作三件套。** ①pending 态（按钮 disabled + 文案）；②结果反馈走 `useToast()`，失败走 `useFailureToast()`（常驻不自动消失、`role="alert"`、带「复制给工程」）；③破坏性操作走 `ui/ConfirmDialog`，不可逆的填 `consequence: { effect, reversible: false }`，它会渲染「不可撤销」红条并把主按钮换成危险样式。需要运营手写理由的（实验启停、审核处置、系统级默认值改写）由 dialog 收理由，不要在代码里替运营编一句 `reason`。旧派视图仍用 `section-kit` 的 `useWriteFeedback` / `WriteFeedbackBanner`，它是接到全局 toast 的唯一接缝。

**错误不许把技术串糊给运营。** authority 读取失败用 `ui/AuthorityRequestError`，命令失败用 `ui/request-error-copy` 的 `operatorErrorCopy(cause)`，原始报错折进 `ui/RequestErrorDetails`。`COPY_BY_CODE` 的 key 是 main `AppErrorCode` 的全集，别在别处再映一遍。硬规则：**5xx 与断网不许说「什么都没写」**——那是猜的，如实说「是否已写入未知，先去核对当前状态」。权限码同理，用 `ui/permission-copy` 的 `permissionLabel()` 翻成能力名（`Record<AdminPermissionKey, string>` 是全集，shared 加码而这里漏了会编译不过）。生成失败原因查 `generation/failureReasons.ts`，查不到出处的码走兜底，不要编一条原因——运营会照着它做错误的动作。

**i18n：域字典只加不改。** 中文文案按域分文件（`i18n-zh-characters.ts` / `-customers` / `-platform-ops` / …），通用文案归 `i18n-zh-common.ts`。扁平词典没有命名空间，同名即静默覆盖，所以 key 必须在域文件之间互斥——`i18n-zh-exclusivity.test.ts` 盯着跨文件重复、同文件重复和「域文件没被 `i18n.tsx` 合并进去」三件事，`i18n-completeness.test.ts` 盯着「每个 key 有中文」和「界面上的英文字面量都过了 `t()`」。两个分支各自往自己的域字典里加同一条通用文案，合并时一定红——直接把它挪进 common。状态词等枚举走 `value()` / `zhValues` 通道，不要走 `t()`。

**外壳偏好走 cookie，不走 localStorage。** 语言、工作模式、侧栏展开态在 `shell-preferences.ts`，服务端在 `render-admin-route.tsx` 首帧就读得到。往 localStorage 里塞任何影响首帧渲染的东西，都会把「英文 + 全折叠」的闪帧带回来；`admin-route-shell.test.tsx` 有源码断言拦着。

**加导航目的地要两边一起改。** `nav-routes.ts` 的 `ADMIN_SECTION_IDS`（纯解析层，`proxy.ts` 靠它在响应体流式输出前判定 404，不能 import 组件）和 `nav-config.tsx` 的 `navItems` 必须对称：proxy 说「存在」而页面解析不出来，就又回到 200/404 不一致。`nav-config.test.ts`、`nav-route-coverage.test.ts`（防止目的地被同级动态段吃掉）和 `proxy.test.ts` 分别守这三面。

## 验证

```bash
cd packages/admin && bun run check && bun run test
```

`check` = lint + typecheck + production build，`test` = vitest。

### 在 git worktree 里跑测试：先怀疑环境，再怀疑代码

**gitignore 的文件不会跟着进 worktree**，缺什么就报什么，而症状全都长得像代码回归。本轮在这上面栽过三次：

| 缺什么 | 症状 | 补上之后 |
|---|---|---|
| `packages/*/.env` | `packages/main` 的 admin-v2 chat outbox 集成测试报 **503**，4 条红 | 软链过去，13/13 通过 |
| `packages/*/next-env.d.ts` | Playwright workspace lease / cleanup 测试报 `ENOENT`，3 条红 | 拷过去，8/8 通过 |
| `node_modules`（软链到主仓库） | Turbopack panic，`build` / `dev` 起不来 | 见下 |

**定性方法**（三步都做完才能下「不是回归」的结论）：先在主仓库跑同一个测试做对照 → 再查本轮有没有碰过相关文件 → 最后补齐环境重跑。

### Turbopack 的软链 panic

**想跑 `build` / `dev` / 浏览器验证，会先撞上一堵墙。** Turbopack 直接拒绝：

```
Symlink [project]/packages/admin/node_modules is invalid, it points out of the filesystem root
```

`vitest` 和 `tsc` 不受影响，照常跑；只有 `next build` / `next dev` 起不来。报错点名的是 `packages/admin/node_modules`，但**真正的元凶是 `node_modules/node_modules` 那条指向主仓库的绝对路径自引用软链**——别照着报错去猜「worktree 天生不能 build」。三个办法，按代价排序：

1. 回主仓库工作树做运行态验证；
2. 在该 worktree 里跑一次真实 `bun install`（约 5 秒 / 1815 个包，装成实体目录）；
3. APFS CoW clone（约 10 秒）——把各层 `node_modules` 软链换成 `cp -Rc` 的克隆，**并把 `node_modules/node_modules` 改成指向 `.` 的相对软链**（关键就是这一条）。用完记得还原成软链，别把约 1.3G 的克隆留在 worktree 里。

**起服务前先确认端口是空的**，别只挑一个「看起来没人用」的号：

```bash
lsof -ti :<port>   # 期望无输出
```

多 agent 并行时很容易绑到别人留下的陈旧 `next-server` 上——两个进程都 listen 同一端口，你的 curl 打中的是旧那个。症状极具误导性：每个请求 500、而你自己的日志一片空白，看起来像自己的代码炸了。
