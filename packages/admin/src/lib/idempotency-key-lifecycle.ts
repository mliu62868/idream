/**
 * SPEC: 幂等键的完整生命周期——生成、按意图复用、结论后回收——只有这一份实现。
 *       调用方表达「我要写什么」，永远不表达「用哪个键」。
 *
 * INTENT: 后台曾有四种手写键的写法并存：每次点击造新 UUID、挂载时造一个成功后换、`useRef`
 *         按签名缓存、以及 journal / durable-intent 自己持久化。前三种是同一个状态机被抄了
 *         三遍，第一种抄错了方向——丢响应后重试就是第二次真实写入，`330eb71e1` 记的重复语音
 *         克隆扣费就是它。把状态机收进一个模块之后，「点一次写两次」在调用方那里**写不出来**。
 *
 * INVARIANT: 纯内存、纯同步、不碰 localStorage 也不碰 fetch。持久化恢复（重放原 POST 还是
 *            问回执）是 `durable-mutation-intent` / `character-command-journal` 各自的事，
 *            ADR-13 §3.2 明说不要合并；这里只做两者共用的前半段——键怎么来、什么时候换。
 */

/**
 * SPEC: 一次写入请求的结局。
 * - `answered`：服务端给出了结论（成功，或一个确定性的拒绝）。这一轮意图结束，键回收。
 * - `unknown`：我们不知道写入落没落地（网络断、请求被取消、网关 5xx / 408）。键必须留着，
 *   下一次重试要带同一个键，让服务端去认它自己的账。
 */
export type IdempotencyOutcome = "answered" | "unknown";

export type IdempotencyKeyLedger = {
  /**
   * SPEC: 为「对 `scope` 这个目标、做 `signature` 这件事」取一个幂等键。
   *       同 scope 同 signature 再次调用返回同一个键；signature 变了就换新键并丢弃旧的。
   */
  claim(scope: string, signature: string): string;
  /**
   * SPEC: 把一次写入的结局告诉账本。
   * INVARIANT: 只认自己那一把键——签名已经变过、键已经换过之后，迟到的 settle 不许把
   *            新一轮的键抹掉（慢请求返回时用户往往已经改了输入再点了一次）。
   */
  settle(scope: string, key: string, outcome: IdempotencyOutcome): void;
  /** 当前还捏在手里没回收的键数。只给测试和诊断读。 */
  readonly held: number;
};

export function createIdempotencyKeyLedger(
  createKey: () => string = () => crypto.randomUUID(),
): IdempotencyKeyLedger {
  const held = new Map<string, { signature: string; key: string }>();
  return {
    claim(scope, signature) {
      const current = held.get(scope);
      if (current && current.signature === signature) return current.key;
      const key = createKey();
      held.set(scope, { signature, key });
      return key;
    },
    settle(scope, key, outcome) {
      if (outcome === "unknown") return;
      if (held.get(scope)?.key !== key) return;
      held.delete(scope);
    },
    get held() {
      return held.size;
    },
  };
}

/**
 * SPEC: 后台全进程共用的一本账。
 * INTENT: 键必须活得比组件长——运营点完按钮切走再切回来、或者 React 重挂一次面板，重试仍要
 *         带同一把键。挂在组件 state / ref 上的旧写法在重挂时就把键丢了。
 */
export const adminIdempotencyKeyLedger = createIdempotencyKeyLedger();

/**
 * SPEC: 从一次失败里判断写入到底有没有落地。
 * INVARIANT: 拿不准就算 `unknown`。算错成 `answered` 是「重试写第二次」，算错成 `unknown`
 *            只是「下一次同样的请求被服务端去重」——后者可逆，前者是扣了两次费。
 */
export function idempotencyOutcomeOfStatus(status: number | undefined): IdempotencyOutcome {
  if (status === undefined) return "unknown";
  if (status >= 500 || status === 408 || status === 425) return "unknown";
  return "answered";
}
