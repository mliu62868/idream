# Admin Character 简化复盘

## 当前产品边界

Character Admin 只服务角色设定、素材生产、预览、发布和上线后的表现观察。

- 不设置项目简报、负责人或计划上线时间。
- 不设置逐角色 QA Run、人工发布审核或定时发布。
- 不设置项目阶段或 Character 专属协作/交接流程。
- 素材逐张选择属于创作过程，不是额外的角色发布审核层。

## 发布体验

发布区只有一个主动作：`Publish Character`。

点击后，服务端从当前不可变角色版本与素材包创建 Release，自动执行必要的技术检查，再提交幂等发布命令。检查失败时直接返回可修复原因；检查通过后原子切换 `CharacterServing.currentReleaseId`。历史 Release 只用于追溯和回滚。

技术检查折叠展示，不要求运营填写 QA 表单，也不成为单独工作流。

## 保留项

- `ReleaseValidationRun` / `ReleaseCheckResult`：系统自动生成的技术证据。
- `CharacterRelease`：不可变发布快照。
- `CharacterServing`：当前线上指针与 `inactive | live | paused | retired` 状态。
- 素材 review decision：证明某张生成素材被采用，不扩张为角色级 QA。

## 一致性结论

Admin、API、共享契约、权限、数据库模型和迁移都以一次即时发布为准。旧的 propose / validate / review / schedule 路由与角色级 QA 存储不再存在。
