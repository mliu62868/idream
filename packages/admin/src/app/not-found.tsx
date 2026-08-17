import AdminNotFound from "./admin/not-found";

// SPEC: 根 not-found 槽复用 admin 段那一份，只为把一份用不上的负载从 payload 里清掉。
// INTENT: 这不是「proxy 404 的唯一落点」——段级 app/admin/not-found.tsx 本来就接得住。
//         把 flight payload 按元素行拆开看（判据用 props 签名 attemptedPath，只有
//         AdminNotFoundPage 收这个 prop）：**没有本文件时，段级那份已经以元素形式渲染进树里**，
//         Next 内置的 404 树只是挂在**根槽**上、没人引用。
//         本文件的作用是把根槽也指向同一个组件，于是那棵内置树从 payload 里消失
//         （实测 14056 B → 12745 B）。
// TRADEOFF: 代价是 AdminNotFoundPage 在 payload 里出现两次（根槽一份、段边界一份），只有一份
//         会显示。净负载仍然是减少的，所以留着；但它是负载清理，不是功能必需——哪天觉得这份
//         重复更碍眼，删掉本文件不会让 404 页消失。
// INVARIANT: 两个槽必须渲染同一个东西，所以这里 export default 复用而不是抄一遍——抄一遍就会
//         在下次改文案时只改一边，而只有其中一边是运营真正看得到的。
export default AdminNotFound;
