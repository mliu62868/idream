// SPEC: chat 服务对外的错误载体 —— code 给客户端分支，status 给 HTTP 层。
// INTENT: 从 service.ts 搬出来，好让 session-access.ts 能抛它而不产生循环 import。
//         service.ts 依赖 session-access.ts，所以错误类型必须比两者都低一层。
export class ChatError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
