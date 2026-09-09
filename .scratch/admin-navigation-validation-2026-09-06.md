# Admin 导航验证记录 · 2026-09-06

## 修订范围

基于 HEAD `cbf0499728be84a19d8b9b9ca13b679ce16babe4` 加当前未提交导航改动。原有 Today WIP 未修改。没有提交或推送，没有执行业务命令或数据库变更。

- `packages/admin/src/components/admin/AdminConsoleClient.tsx`: `1f1266982c34e3e430b827ed351d73a6c431058e902ab39a0ed374ac83bf9ab9`
- `packages/admin/src/components/admin/AdminNavigation.tsx`: `cb171ed68c469e98d2864c4fc0845759c45348dd2b8dcd44a5133ae3322284cb`
- `packages/admin/src/components/admin/nav-config.tsx`: `7578b2da82a039916167a431f20054e5b6cdddf0999551d0a9bf71891c11b9ae`
- `packages/admin/src/components/admin/i18n-zh-common.ts`: `0559b4cfa7d751b6426cd4ab18ab6e2c4041a7bce05527df7cebd05dbcbc4c3a`
- `packages/admin/src/components/admin/i18n-zh-shell.ts`: `398dd67759f4d4c3c51e76f7d47490997679f786a06eb5c5cd700044587a1d7f`

## 自动化

- Admin 全量测试：185 文件、1148 项通过（05:00 UTC 前完成，包含 7 种工作模式下全部 38 个目的地的真实目录展开验证）。
- 最后的长目录定位修复：2 文件、18 项专项回归通过，其中新增当前项滚入目录视口且不滚正文的测试。
- Admin lint：0 errors；6 个未修改文件中的既有 warnings。
- Admin typecheck 通过。
- 最终 Admin production build 通过。release id: `idream-30ecd6d9-fd7b-4ae4-bb93-c21ca18d9771`。构建产物未用于生产部署或服务重启。
- git diff --check 通过。

## 实际浏览器

Codex 内嵌 Chromium 浏览器，`http://localhost:3001`，本地开发管理员登录；界面为中文。读取实际页面数据，没有修改内容、定价、权限或执行重试／丢弃。

1. 默认目录直接显示八个业务入口，系统管理在末尾。
2. 从今日工作展开内容运营，URL 不变；可见运营素材、展示位、精选推荐、公告、站点内容与 SEO。
3. 点击运营素材加载真实资产页，页头、面包屑与目录名称一致。
4. 从精选推荐切换公告，仅 query 改变；最终 URL `/admin/growth/merchandising?view=announcements`，页头和唯一 `aria-current=page` 均为公告。
5. 390 × 844：打开抽屉、切换收入与营销、点击定价后自动关闭，面包屑显示收入与营销。
6. Escape 关闭抽屉后焦点返回“打开导航”；document scrollWidth 与 innerWidth 均为 390。临时 viewport 已重置。
7. 直接打开 `/admin/ops/jobs?view=dead-letter`，平台运维及工具与诊断自动展开，死信为当前项。
8. 1280 × 720 下修复前死信项位于 y=781–825，落在目录视口外；修复后目录 scrollTop=117，当前项 y=664–708，在目录 y=56–720 内，window.scrollY=0。

## 限定

这是全局导航与入口的运行证据，不是全部业务工作台内部流程或公开生产就绪证明。没有运行真实生成、支付或发布。
