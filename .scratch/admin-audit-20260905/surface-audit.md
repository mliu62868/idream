# Admin surface audit — 2026-09-05

## 范围与证据边界

只读检查 Admin 信息架构、角色审核及角色外运营页面、权限与静态 API 路由；未修改产品代码、数据或服务。源码 HEAD：`bae20386f636bfb59389829d8574063f5339263d`。本子任务未执行浏览器或真实写入闭环，以下单元/挂载测试及静态匹配不代表完整端到端通过。

## Findings

### P1：角色审核缺少决策材料

`packages/admin/src/components/admin/ReviewQueueView.tsx:252-280` 的列表仅展示名称、性别、风格、简介、举报数量、提交日期和 Approve/Reject；`:435-446` 的表头声明简介截断。没有角色详情链接、图片、年龄、Soul、举报正文，审核员在当前页面无法看清审核对象和举报依据。`:582-614` 的确认弹窗只有状态说明、review note、audit reason 和 submission UUID 输入，没有补充审阅内容。

Main `packages/main/src/server/modules/admin-v2/content/review.ts:35-46` 的 `characterSelect` 不包含年龄或 Soul；虽返回 `imageAssetId`，页面没有展示它。该缺口属于运营决策上下文，不是要求改变既定审核策略。

建议先提供可展开审核详情、真实图片、角色资料与举报依据，再做决策。保留当前“Approve 只开始 publication prep，Asset/QA/Release 完成后才上线”的明确边界。

### P2：只读人员看到可执行的 CMS 写操作，填写后才被服务器拒绝

`packages/admin/src/components/admin/nav-config.tsx:241-242` 的 CMS 导航仅要求 `content.read`，渲染 `CmsView` 不传写权限。`packages/admin/src/components/admin/CmsView.tsx:80` 的组件没有权限 props，`:252-287` 的 Edit/Unpublish/Publish 按钮只按内容状态、busy 和 publishability 判断，没有写权限判断；创建区同样没有写权限门槛。

`packages/shared/src/admin/permissions.ts:100-120` 的内置 support 角色拥有 `content.read`，不拥有 `content.cms.write`。Main `packages/main/src/server/modules/admin-v2/cms/pages.ts:35` 声明 CMS_WRITE=`content.cms.write`，`:138`、`:179`、`:237` 写操作均要求该权限。服务器权限有效，但支持人员可以进入 CMS、填写或确认操作，最终才收到 403。

建议把实际写权限传入 CMS，提前隐藏/禁用写操作并解释只读原因。ReviewQueue、Taxonomy、Announcements 等无权限 props 的页面应统一核对，不能把后端鉴权有效等同于 UI 权限表达清晰。

## 信息架构与 UX 判断

当前七工作区、primary/workspace/tool 三级披露、角色制作与 Growth Character Performance 分离，方向合理；无需以“简洁”为由删掉低频运营能力。应优先修决策上下文和权限表达，而非重做导航。

两个可改进的技术操作负担（UX 建议，不冒充已发生的运行故障）：

- `packages/admin/src/components/admin/CmsView.tsx:475-481`、`:625-628` 要求运营直接编辑 article body JSON，适合改为正文/章节字段编辑，保留低频原始数据入口。
- `packages/admin/src/features/cases/CaseWorkspace.tsx:510` 要求手工填写 evidence IDs 和 outcomeRef，可用真实证据选择器和目标动作链接减少查 ID 与复制错误。

## Verification

实际执行命令：

```sh
bun run --filter @idream/admin test
bun run --filter @idream/admin typecheck
bun run --filter @idream/admin lint
```

结果：

- test：183 files passed，1116 tests passed，Duration 12.24s，exit 0。
- test 输出包含 4 次 happy-dom teardown `DOMException [AbortError]: The operation was aborted.`，未计为失败。
- typecheck：exit 0。
- lint：exit 0，0 errors / 8 warnings。

lint warnings：

- `packages/admin/scripts/start-development.test.cjs:7`：nextCli 未使用。
- `packages/admin/src/components/admin/CmsView.tsx:112`：useEffect 缺 load 依赖。
- `packages/admin/src/components/admin/ExperimentsView.mounted.test.tsx:51`：init 未使用。
- `packages/admin/src/components/admin/InsightsView.tsx:91`：reportFailure 未使用。
- `packages/admin/src/components/admin/InsightsView.tsx:109`：useCallback 的 t 依赖不必要。
- `packages/admin/src/components/admin/ReviewQueueView.tsx:643`：truncate 未使用。
- `packages/admin/src/components/admin/TagsView.tsx:93`：tags 表达式影响两个 useMemo 依赖（99、108 行），共两条警告。

另外用 Python 提取 Admin 非测试 TSX 中固定 `/api/v1/admin/*`、`/api/v2/admin/*` 路径，去除 query 后匹配 Main `src/app/**/route.ts`（动态路由段按单段参数匹配），未发现静态缺失路由。该检查不覆盖带 `${...}` 的模板路径、HTTP 方法、响应契约和真实网络状态。

## 避免历史误报

历史 Chat `/internal/admin/*` 失连不能当作当前缺陷。当前 `packages/main/src/server/modules/admin-v2/chat/operations.ts:34` 及后续代码已经从 Main 数据表读取产品事实，Chat 仅提供 runtime diagnostics。旧记忆已与当前源码核对，未作为当前失败证据。

## 补充：真实浏览器与 Main 集成测试

主代理反馈：已在真实浏览器走完全部七工作区代表入口；使用 support 身份打开 CMS，填写后能够提交，随后真实返回 `Missing admin permission`，未创建记录。该证据确认上述 CMS 只读问题，不再仅限静态推断。截图与浏览器证据由主代理归档。

已先列明五目录覆盖，共 30 个测试文件，清单见 `main-surface-test-files.txt`。统一执行一次标准 Main test，不含 `admin-v2/characters` 目录。按主代理确认的隔离环境显式指定 PostgreSQL `localhost:5433/idream_test` 与 Redis DB15：

```sh
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/idream_test REDIS_URL=redis://127.0.0.1:6379/15 bun run --filter @idream/main test src/server/modules/admin-v2/cms src/server/modules/admin-v2/content src/server/modules/admin-v2/cases src/server/modules/admin-v2/incidents src/server/modules/admin-v2/support > .scratch/admin-audit-20260905/main-surface-tests.log 2>&1
```

该测试按标准配置重建并 seed 专用测试库，fileParallelism=false，各文件串行；provider 为测试 mock。它验证真实 PostgreSQL 持久化、命令、权限和恢复逻辑，但不等同于真实模型生成或公开生产就绪。

结果：**30 个测试文件全部通过，187 tests 全部通过，exit 0，58.71s**（import 27.09s，tests 19.48s）。日志包含故障注入用例预期的 `injected content asset audit failure` / `injected case receipt failure` 等 error 级记录；对应测试通过，不能将这些注入日志误报为运行环境故障。

完整日志：`.scratch/admin-audit-20260905/main-surface-tests.log`。无需重复运行或扩大测试；该范围当前验证无失败。
