# 角色工作区检查与修复 · 2026-09-02

截图中的角色图片库已恢复。原请求返回非 JSON 500，修复后返回 200 和原有的 3 张图片；视频库返回 1 条视频，角色工作区也返回 200。

本轮依据四个产品事实排查：读取失败不能证明素材不存在；素材归属不随发布可见性改变；归档后的素材不再出现在库中；按钮权限必须与实际接口一致。保留“生成/导入 → 素材库 → 运营选图 → 发布”的独立阶段。

## 根因与修复

- **图库 500**：当前源码已查询 `CreativeReviewDecision.runItemId: null`，Main 开发进程仍持有旧 Prisma client，因此抛出 `Argument runItemId is missing`。生成匹配客户端并重启单个 `main-web` 后，原请求恢复。数据库只读核查确认字段已可空、相关迁移已完成；本轮未执行迁移。
- **非 JSON 错误**：Admin v2 路由对未知异常直接抛出，落入 Next 的非 JSON 500 响应。现统一返回 JSON 错误信封，详细异常和 requestId 保留在服务端日志。
- **素材加载状态**：图片、视频、运营选图分别区分加载失败、真实空库、搜索无结果。失败可重试；刷新失败保留上次列表并明确提示。重试读取不会重复提交导入或审核。
- **素材生命周期**：角色图库不再漏掉 `public_pack`、`unlisted` 图片；已归档图片不再返回。审核未通过的候选仍保留在库中供处理。身份实验源继续限定私有来源，角色隔离保持有效。
- **权限**：图片库和视频库分别依据实际读取接口授权；导入图片审核与生成图片审核分开；标签、聊天生图、视频导入、系统声音试听使用各自权限。没有内容读取权时不发出必然失败的请求。
- **文案**：补齐图片审核、资格状态、选图提示的中文；图片审核不再显示“审核候选声音”；首次发布不再出现事故队列文案。

## 本轮浏览器证据

使用内置浏览器、本地管理员测试账号，以及原截图角色 `2414a1d9-74a2-4125-bf7c-92be6368f572`。下列截图均为本轮实际页面。

1. 图片库：正常。3 张原有图片恢复，资格显示正确。

![恢复后的图片库](/Users/kk/code/idream/artifacts/character-repair-2026-09-02/01-image-library.png)

2. 搜索：正常。无匹配显示“没有匹配的图片”，清除搜索恢复列表。

![搜索无结果](/Users/kk/code/idream/artifacts/character-repair-2026-09-02/02-search-no-results.png)

3. 视频库：正常。已生成视频和 5 秒媒体控件加载。

![视频库](/Users/kk/code/idream/artifacts/character-repair-2026-09-02/03-video-library.png)

4. 运营选图与预览：正常。封面、主视觉、聊天场景分别展示现有图片；封面选择器加载当前合格素材，当前图片禁用重复选择；主站草稿预览正常加载。

![运营预览](/Users/kk/code/idream/artifacts/character-repair-2026-09-02/04-placement-picker.png)

5. Soul 设定：读取正常。当前版本、名称、年龄、开场和 Markdown 编辑内容一致。本轮未创建新的不可变 Soul 版本。

![Soul 设定](/Users/kk/code/idream/artifacts/character-repair-2026-09-02/05-soul-settings.png)

6. 声音设置：读取正常。系统继承音色与候选表单加载；试听权限由挂载测试验证，本轮未额外生成声音。

![声音设置](/Users/kk/code/idream/artifacts/character-repair-2026-09-02/06-voice-settings.png)

7. 390px 窄屏：正常。图片库加载完成，页面与文档宽度均为 390px，无横向溢出。此检查不等同完整无障碍认证。

![窄屏图片库](/Users/kk/code/idream/artifacts/character-repair-2026-09-02/07-image-library-mobile.png)

8. 首次发布：文案正常。显示“还没有发布版本”和创建首个版本提示；本轮未点击发布。

![首次发布状态](/Users/kk/code/idream/artifacts/character-repair-2026-09-02/08-release-ready.png)

## 验证范围

最终验证均以退出码 0 完成：

| 验证 | 结果 |
| --- | --- |
| Admin `bun run test src/features/characters` | 37 文件，303/303 |
| Main 路由错误信封与图片资格纯测试 | 2 文件，13/13 |
| Main 图片库数据库集成测试 | 1 文件，4/4 |
| Admin / Main 类型检查 | 通过 |
| 改动文件 ESLint、`git diff --check` | 通过 |

真实 HTTP 结果见 [http-verification.json](/Users/kk/code/idream/artifacts/character-repair-2026-09-02/http-verification.json)。浏览器收尾控制台无 error。

图库数据库集成测试使用现有 `idream_test`，禁用全局 schema reset，仅创建和清理本测试的随机 fixture；4/4 通过，账号、角色、素材、命令、审计和审核测试残留均为 0。覆盖发布可见性、归档、审核拒绝保留、角色隔离及实验源隔离。

这是当前开发工作树的定向修复和回归验证，基线 HEAD 为 `3e8632ea0f974b24fc31568ccd1d5aeda0a76b1c`。保留原有未提交修改。本轮没有新一轮图片/视频/语音生成、公开发布或数据库模式变更，也不代表全栈生产发布认证。

验证时的工作树指纹与监听进程见 [source-verification.json](/Users/kk/code/idream/artifacts/character-repair-2026-09-02/source-verification.json)。
