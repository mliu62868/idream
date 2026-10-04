export const AGE_GATE_COOKIE_NAME = "AdultContentAcceptedOD";

// SPEC: 首帧前的视觉提示。带服务端写下的年龄门 cookie 时，静态 HTML 里的黑色
//   「Checking age access」遮罩在首次绘制前就隐藏；内容仍是 inert，受保护的数据加载
//   仍要等 AgeGateBoundary 向 Main 回写 DB 权威成功（useAgeGateAccess 才变 accepted）。
// INTENT: 前台几乎全部走 [...slug] 的 ISR。在根布局读 cookies()/会话会把全站变成按请求
//   动态渲染，所以不在 SSR 里查 DB，而用这段内联脚本只去掉「已接受者每次硬加载闪黑屏」。
// INVARIANT: 这只是视觉，不是放行：cookie 由 Main 在 DB 接受成功后 Set-Cookie，客户端代码
//   不自行写出它；伪造它只能看到本就在静态 HTML 里的内容，拿不到任何年龄门后的数据或操作。
//   DB 判定失败时 AgeGateBoundary 进入 blocked 并移除该属性，阻断弹窗不受此提示影响。
export const AGE_GATE_HINT_ATTRIBUTE = "data-age-gate-hint";

export const ageGateHintScript = `(function(){try{if(/(?:^|;\\s*)${AGE_GATE_COOKIE_NAME}=true(?:;|$)/.test(document.cookie)){document.documentElement.setAttribute("${AGE_GATE_HINT_ATTRIBUTE}","accepted")}}catch(e){}})();`;

export function ageGateAcceptedFromCookieValue(value: string | undefined) {
  return value === "true";
}

export function canStartAgeGatedLoad(
  accepted: boolean,
  initialized = true,
) {
  return accepted && initialized;
}
