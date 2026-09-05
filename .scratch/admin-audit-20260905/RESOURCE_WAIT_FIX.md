# 资源等待与 provider 执行边界修复

状态：此补丁最初在隔离副本验证，现已由 root 应用并通过标准 wrapper 重启。真实 Chrome 已走通受控90秒资源等待、释放后实际生成、一次调用/交付/用量；完整标识、后续自动结算与Creative恢复修复见 output/playwright/admin-e2e-20260905/REPORT.md。下文保留原隔离验证与应用说明。

## 根因与不变量

原 GenerationExecution 在 Backend 获取共享 Apple GPU lease 之前就写 running Transport 和不可重放 invocation guard。Main 因此把纯资源排队计入 provider deadline；仍在等待的活 worker 被 immutable unknown 隔离，随后原产物也因 providerRequestId 从 null 变为真实 ID 被拒绝。

Main 的迟到成功兼容已直接修复并通过 40 个回归：仅无 canonical terminal receipt/ref 的 unknown Transport 原 providerRequestId=null 可以接收同一精确 Dispatch 的非空迟到 ID。原 Attempt/Transport 保留 unknown/null；gen_resolution 保存迟到成功，经现有 adopt_succeeded 入口验证、交付。

隔离 patch 使用既有 transport 事件入口新增 waiting 状态（不是 DB Transport 状态，没有 schema 变更）。waiting 经同 Request/Attempt 锁与 exact Dispatch 校验后，只追加资源等待 AttemptEvent；不写 startedAt、Transport、invocation guard 或 usage。新状态会被旧 Main schema 拒绝，避免旧版本将等待误认成 running。

Backend 获得共享 lease 并完成 Comfy memory preparation 后、submit 前，重新请求 Main running 权威并创建原幂等 guard。原 provider execution deadline 和不可重放规则不变。资源等待每 30 秒检查授权，内部 HTTP 最多等待 10 秒；独立等待预算默认为 2 × GEN_VIDEO_TIMEOUT_MS，可用 GEN_ACCELERATOR_WAIT_TIMEOUT_MS 覆盖。到期尚未调用 provider 时沿原 preparation failure 重试/最终失败规则；不清除超时、不伪造 unknown→running，也不抢活进程的设备锁。

## 验证

- Gen 隔离 cwd，原 vitest alias 指同隔离 Shared src：typecheck 通过；pipeline/backend image/backend video/accelerator lease/transport/env 共 6 文件 148 tests 通过。
- 将最终权限检查放到 memory preparation 之后又定向复核两 Backend：49 tests 通过。
- Shared 隔离 durable 契约 7 tests、typecheck 通过。
- Main 标准 globalSetup，localhost:5433/idream_test、Redis 15 与测试 prefix、独占 DB：隔离 transport endpoint + Shared alias 集成 5 tests 通过。覆盖等待无 provider 时间/usage、重复 heartbeat、错误 Dispatch、取消拒绝、等待后真正进入 provider、真正执行过期仍 unknown。
- Main staged endpoint + test 定向 tsc 通过，endpoint ESLint 通过。
- git apply --check --whitespace=error 通过。每个文件 before/after SHA-256 见 resource-wait-execution-files.json。

Main 隔离集成命令（仍需独占标准测试库）：

```sh
cd /Users/kk/code/idream/packages/main
bun run test --config ../../.scratch/admin-audit-20260905/resource-wait-main.vitest.config.ts
```

应用（仅原 worker 完成后）：

```sh
cd /Users/kk/code/idream
git apply --check --whitespace=error .scratch/admin-audit-20260905/resource-wait-execution.patch
git apply .scratch/admin-audit-20260905/resource-wait-execution.patch
```

部署先使 Main 支持 waiting，再启动新 Gen。应用后使用项目标准 wrapper 完成 source restart，并验证一个实际受设备占用影响的任务，其 waiting Event 先于 running Transport/startedAt，只有一次 provider submission。该真实新协议验证尚未执行，正在运行的两条旧任务只能通过原 late-success/reconciliation 路径恢复。
