# 全面检查任务书

给 codex 及其他外部 agent 用。

"全面检查项目"不是可执行任务——没有起点、没有切面、没有验收口径，任何模型都会退化成
通读 `docs/product/` 然后改写一份总结。那些文档的 SSoT 已多次被证实与代码不符。
按下面四步把它变成可执行任务。

## 1. 钉住起点

检查开始前必须有一个稳定的 source revision，否则结论无法归因也无法复现。

```bash
git status --porcelain | wc -l      # 不是 0 就先处理
bun run source:revision             # 记下来，写进产出文件
```

工作区脏（常见：另一个会话正在写）时，二选一：

- 让用户先提交或 stash；
- 在独立 worktree 检出目标 commit 再查：
  `git worktree add ../idream-audit <revision>`（需自带 `.env`、跑 `bun install` 与 prisma generate）

同一时刻只让一个 agent 驱动浏览器和 dev server。

## 2. 一次一个切面

单轮任务只覆盖一个切面，覆盖不全比结论不可信好。可选切面：

- 聊天：turn 交付、重试恢复、记忆抽取、模型延迟
- 生图：生成 → 交付 → 持久化 → 扣费/退款
- 视频 / 语音
- 计费与额度：发币、扣减、退款、双排水
- 后台运营：导航目的地可达性、列表/详情/新建三件套
- 主站前台：未认证可见性、软 404、移动端与平板溢出
- 数据不变式：跨表账目、孤儿行、未认领行
- 上线就绪：`bun run check:launch`

## 3. 证据口径

`mock`、页面可点击、构建通过，都不是功能可用的证据。以下是本仓库已付过学费的硬规则：

- `bun run check` 是三件套（lint + typecheck + build），只跑 tsc 不算
- SSR 行为改动必须重启服务后 `curl` 真实页面（带查询参数）验证
- 浏览器验证前确认 `document.visibilityState === 'visible'`，后台标签页会冻结水合，
  造出"永久加载中、不发请求"的假 P0
- 引用任何计数前，按 description 排掉探针和测试账号的写入
- `packages/main` 全量测试会间歇性失败；挂了先单独重跑那个文件再下结论
- 真实生成/API 调用用最低充分次数，记录 provider、model/workflow、
  request/attempt/artifact 标识、耗时、额度扣减与交付结果

文档记录需求与决策，运行证据证明实际状态。二者冲突时说明冲突，不凭代码现状废除业务要求。

## 4. 产出

按 [事项追踪](issue-tracker.md) 写进 `.scratch/<slug>/`，不要新增 `docs/` 文档。

- 开头写 source revision、切面、验证时间
- 每条发现：现象 → 复现命令或路径 → 证据（含退出码 / ID）→ 影响面 → 定性
- 定性用 [分诊状态](triage-labels.md)，不自造等级
- 明确写出"查了但没问题"和"没查"的范围
- 不确定的写成待验证项，不要升格成缺陷

## 不要做的事

- 不要把 `MODERATION_PROVIDER=mock`、`safety-gateway` 未启用、video 恒 mock
  列为缺口——都是既定产品决策
- 不要因为当前实现有缺口就缩减 PRD 需求
- 不要碰生产库；开发库与专用测试库的 schema 变更已获授权
- 不要在报告里写没有实际执行过的命令输出
