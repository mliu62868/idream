// SPEC: Build the model context for a turn (design §3 step 8). Recent messages +
// rolling summary come from PG (authority). Persona/entitlement from read-only
// views. Long-term memory + boundaries from the file layer, with a TIMEOUT budget:
// on timeout/error we degrade to "recent messages only" and never block the reply
// (design §5 hot-path degradation). memory_enabled=false reads NO long-term memory.
import type { ChatPrismaClient, ChatCharacterView } from "./db.js";
import { chatFsPaths, readWhole } from "./chat-fs.js";
import { resolvePolicy, snapshotFromView, type ChatPolicy } from "./policy.js";

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

  // File-layer memory read with a timeout budget — degrade on slowness.
  let boundaries: string[] = [];
  let longTermMemories: string[] = [];
  if (memoryEnabled && policy.maxMemories > 0) {
    const read = readMemoryFiles(userId, characterId, policy.maxMemories);
    const degraded = await withTimeout(read, MEMORY_READ_TIMEOUT_MS, { boundaries: [], memories: [] });
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

async function readMemoryFiles(
  userId: string,
  characterId: string,
  maxMemories: number,
): Promise<{ boundaries: string[]; memories: string[] }> {
  const [boundariesRaw, memoryRaw] = await Promise.all([
    readWhole(chatFsPaths.boundaries(userId)),
    readWhole(chatFsPaths.memory(userId, characterId)),
  ]);
  const boundaries = parseMemoryLines(boundariesRaw);
  // memory.md: newest entries last; take the most recent maxMemories lines.
  const memories = parseMemoryLines(memoryRaw).slice(-maxMemories);
  return { boundaries, memories };
}

/** Memory files are markdown bullet lines; ignore headings/blank/frontmatter. */
function parseMemoryLines(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter((l) => l.length > 0 && !l.startsWith("#") && l !== "---");
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
