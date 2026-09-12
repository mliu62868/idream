# AC-02 邮箱验证与访问恢复实现契约

本次补齐邮件验证码申请、重发、过期和无恢复码时的邮箱恢复，保留原有一年期一次性恢复码。既有未验证账号仍可登录和使用产品；本次没有引入强制邮箱门禁。Main 的 User、Account、Session、Verification 是唯一权威。

## 用户路径

- 已登录：Profile → Account management → Email verification。邮箱来自当前账号，不能在申请中替换收件地址。验证码确认成功后设置 `User.emailVerified=true`。
- 忘记密码：Login → Recover access → Recover with an email code。输入注册邮箱，申请验证码，输入最新验证码及新密码。成功后撤销该用户全部旧 Session，轮换已保存的恢复码，建立新的 Session，先要求保存新恢复码，再进入原有安全返回路径。
- 保留恢复码：原入口和接口不变。用恢复码重置或手动轮换恢复码时，同时撤销未使用的邮箱验证码。账号进入删除流程立即撤销邮箱验证码；最终擦除再作防御性清理。
- 网络结果未知：不自动重复确认或付费动作，提示先尝试用新密码登录并重新保存恢复码；否则再申请验证码。

## API

路径前缀均为 `/api/v1`。既有 `dispatchAccountAccess` 分发，无需新增 service.ts 接线。

| API | 请求 | 成功结果 |
| --- | --- | --- |
| `GET /account/email-verification` | 当前 Session | `userId,email,verified,available` |
| `POST /account/email-verification/request` | `expectedUserId` | 202，`challengeId,expiresAt,resendAt` |
| `POST /account/email-verification/confirm` | `expectedUserId,challengeId,code` | `userId,verified:true` |
| `POST /auth/password-reset/request` | `email` | 202，同一申请响应格式 |
| `POST /auth/password-reset/confirm` | `email,challengeId,code,password` | `recovered,userId,recoveryCode,recoveryCodeExpiresAt` 与新 Session Cookie |

邮箱验证码为随机八位数字，10 分钟有效、一次使用、每次重发替换旧挑战。最多五次错误尝试；第六次即便输入正确码也不能恢复。验证码 HMAC 绑定挑战 ID、邮箱和用途，数据库不保存明文码或邮箱；有效挑战还记录 provider 的 acceptance receipt，不能把 acceptance 解释为收件箱送达。

## 并发、限流与隔离

- 复用 Verification 的独立 `account-email:` 命名空间。其 identifier 原本不唯一；本实现以固定 ID 存限流票据，以 PostgreSQL advisory lock 保证本命名空间的一条当前挑战，不修改 Better Auth 的 schema 或语义。
- 持久限制：邮箱每小时最多 5 次申请、60 秒重发冷却；IP 每小时最多 20 次申请、15 分钟最多 30 次确认。限制不依赖现有可降级放行的 Redis 限流器，PostgreSQL 不可用则失败关闭。
- 校验计数必须提交后再返回失败，不能因抛出事务异常回滚错误次数。User 行锁先于挑战锁，密码更新、旧 Session 撤销、恢复码轮换和新 Session 同一事务提交。并发消费者最多一个成功。
- 匿名申请对不存在、未启用或没有密码账号的邮箱提交同样的中性验证码邮件；对应挑战绑定空用户，永远不能恢复账号。请求响应、provider 失败和发送路径不暴露账号是否存在。邮箱拥有者提交正确码也不能凭此创建或夺取一个之后注册的账号。
- 缺邮件配置、provider 拒绝、超时或无有效 acceptance receipt 时不产生可消费挑战，不声称发送成功。申请的邮件可能已被 provider 接受但结果未知时，该挑战仍失效，用户需等待冷却后申请新的。
- 每次验证码操作最多清理 100 条本命名空间中已过期超过 24 小时的记录，删除时再次校验过期条件。不会清理 Better Auth 或原恢复码记录。

## 邮件配置与真实送达边界

默认 `ACCOUNT_MAIL_PROVIDER=disabled`；保留原恢复码可用。启用需要 server-only `RESEND_API_KEY`、已验证发件域名的 `ACCOUNT_MAIL_FROM`、`ACCOUNT_MAIL_PROVIDER=resend`。适配固定 HTTPS endpoint，不接受用户提供的邮件服务 URL；HTTP 重定向拒绝，发送有 10 秒超时，使用 challenge ID 作为 Resend idempotency key。

依据官方 [Send Email](https://resend.com/docs/api-reference/emails/send-email) 和 [Idempotency Keys](https://resend.com/docs/dashboard/emails/idempotency-keys) 实现，未接入第二条 Better Auth 重置渠道；已核对安装版本中该原生渠道在没有 sendResetPassword 回调时明确返回 RESET_PASSWORD_DISABLED。

本轮不真实对外发邮件。自动化测试仅 mock transport，地址均为可识别的 `@customer.invalid`；数据库/API/Session/并发测试使用专用测试库。生产 API key、已验证发件域、受控实际收件地址及其授权缺失，因此真实收信、spam/延迟/退信和生产送达仍属于 issue08 的外部认证，不能用 transport mock 关闭。

## 验证进度

- 邮件 provider + 验证码 UI + 原恢复码卡/Auth：21 项纯测试通过；Profile mounted：20 项通过。
- 13 项 Main 数据库回归通过，覆盖哈希/一次性、并发消费、重发竞态、分布式错误尝试、过期/跨账号、未知邮箱、发送故障、用途/owner 绑定、安全状态转换、每邮箱/IP限制、未确认发送和清理隔离。原账号恢复 5 项与中央删除权威 10 项也全部通过。使用 `localhost:5433/idream_test`、Redis DB 15 与原始全局 setup/数据库租约；没有修改运行保护。最终日志：`.tmp/product-improvements-20260910/account-email-integration-final.log`，现有账号/删除日志：`.tmp/product-improvements-20260910/account-email-integration-rerun.log`。
- 定向 lint 已通过。Main typecheck 初次暴露测试 fetch mock 的 Bun 类型差异已修正；同时发现的非本子任务泛型问题已交 root。后续全局 typecheck 由 root 统一执行。
