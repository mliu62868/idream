// SPEC: Build the model context for a turn (design §3 step 8). Recent messages +
// rolling summary come from PG (authority). Persona/entitlement from read-only
// views. Long-term memory + boundaries from the file layer, with a TIMEOUT budget:
// on timeout/error we degrade to "recent messages only" and never block the reply
// (design §5 hot-path degradation). memory_enabled=false reads NO long-term memory.
import type { ChatPrismaClient, ChatCharacterView } from "./db.js";
import { env } from "./env.js";
import { resolvePolicy, snapshotFromView, type ChatPolicy } from "./policy.js";
import { retrieveMemories } from "./retrieval.js";

const MEMORY_READ_TIMEOUT_MS = 250;

export interface BuiltContext {
  persona: ChatCharacterView;
  policy: ChatPolicy;
  sessionSummary: string | null;
  recentMessages: Array<{ id: string; role: "user" | "assistant"; content: string }>;
  boundaries: string[];
  longTermMemories: string[];
}

export interface BuildContextInput {
  prisma: ChatPrismaClient;
  userId: string;
  characterId: string;
  sessionId: string;
  memoryEnabled: boolean;
}

export async function buildContext(input: BuildContextInput): Promise<BuiltContext> {
  const { prisma, userId, characterId, sessionId, memoryEnabled } = input;

  const [persona, entitlementRow, session] = await Promise.all([
    prisma.chatCharacterView.findUnique({ where: { characterId } }),
    prisma.chatEntitlementView.findUnique({ where: { userId } }),
    prisma.chatSession.findUnique({ where: { id: sessionId } }),
  ]);
  if (!persona) throw new Error(`character ${characterId} not visible to chat`);

  const policy = resolvePolicy(snapshotFromView(entitlementRow), { memoryEnabled });

  const recent = await prisma.message.findMany({
    where: { sessionId, status: "sent", role: { in: ["user", "assistant"] }, deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: policy.maxContextMessages,
  });
  const recentMessages = recent
    .reverse()
    .map((m) => ({ id: m.id, role: m.role as "user" | "assistant", content: m.content }));

  // File-layer memory retrieval with a timeout budget — degrade on slowness.
  // Query = the latest user turn (semantic ranking when igrep is enabled).
  let boundaries: string[] = [];
  let longTermMemories: string[] = [];
  if (memoryEnabled && policy.maxMemories > 0) {
    const query = [...recentMessages].reverse().find((m) => m.role === "user")?.content ?? "";
    const read = retrieveMemories({ userId, characterId, query, max: policy.maxMemories });
    // Outer hot-path cap. recency = 250ms; igrep mode gets its own budget + margin
    // (retrieveMemories self-degrades to recency on its internal igrep timeout).
    const budget =
      env.MEMORY_RETRIEVAL === "igrep"
        ? env.MEMORY_RETRIEVAL_TIMEOUT_MS + MEMORY_READ_TIMEOUT_MS
        : MEMORY_READ_TIMEOUT_MS;
    const degraded = await withTimeout(read, budget, { boundaries: [], memories: [] });
    boundaries = degraded.boundaries;
    longTermMemories = degraded.memories;
  }

  return {
    persona,
    policy,
    sessionSummary: session?.memorySummary ?? null,
    recentMessages,
    boundaries,
    longTermMemories,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}
