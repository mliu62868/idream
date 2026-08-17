import AdminNotFound from "./admin/not-found";

// SPEC: proxy 判定路径不存在时，落点是**根级** not-found 边界，不是 app/admin 段里那一份。
// INTENT: 实测（dev 与 production standalone build 都复现，同一请求单一变量）：只留
//         app/admin/not-found.tsx 时，/admin/<未知> 的状态码是对的 404，但响应负载里带着
//         Next 内置的 "404: This page could not be found."；补上本文件后那段标记消失。
//         也就是说这一份不是多余的兜底，是那条边界唯一的落点。
// INVARIANT: 两个入口必须渲染同一个东西，所以这里直接复用 admin 段那一份而不是抄一遍——
//            抄一遍就会在下次改文案时只改一边，而只有其中一边是运营真正看得到的。
//
// UNVERIFIED: 这一页最终在浏览器里画成什么样，本轮没有证据。notFound() 是在流式输出开始
//         之后抛出的，响应体里是 `NEXT_HTTP_ERROR_FALLBACK;404` +「Switched to client
//         rendering」的模板，真正的 UI 在客户端产出——curl 抓不到，AdminMessagePage.test.tsx
//         也只覆盖到展示组件本身（直接喂 props，跨不过这层边界）。要确认目的地建议真的出现在
//         运营眼前，需要一次真实浏览器验证。
export default AdminNotFound;
