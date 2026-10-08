import { Context, Service } from "@deepseek-ai/cordis";
import { SessionId, type Session, type SessionEvent } from "@deepseek-ai/dsh-session";

declare module "@deepseek-ai/cordis" {
  interface Context {
    sessionQuery: CompanionSessionQuery;
  }
}

/**
 * The official recall plugin rebuilds a seeded prefix through this async seam.
 * Keep only the current attempt's immutable seed and published append feed;
 * Main remains the historical authority and no DSH session log is persisted.
 */
export class CompanionSessionQuery extends Service {
  static inject = ["sessions"];
  private readonly logs = new Map<string, { seed: readonly SessionEvent[]; tail: SessionEvent[]; session?: Session; failure?: Error }>();

  constructor(ctx: Context) {
    super(ctx, "sessionQuery");
    ctx.on("session/created", (session) => {
      const log = this.logs.get(String(session.id));
      if (log && session.seq === log.seed.length) log.session = session;
    });
    ctx.on("session/event", (session, event) => {
      const log = this.logs.get(String(session.id));
      if (!log || log.session !== session) return;
      if (event.seq !== log.seed.length + log.tail.length) {
        log.failure = new Error("companion recall event sequence is incomplete");
        return;
      }
      log.tail.push(event);
    });
    ctx.on("session/disposed", (session) => { this.logs.delete(String(session.id)); });
    ctx.effect(() => () => { this.logs.clear(); }, "companion recall seed");
  }

  registerSeed(id: string, seed: readonly SessionEvent[]): void {
    if (this.logs.has(id) || seed.some((event, index) => event.seq !== index)) {
      throw new Error("companion recall seed is invalid or already registered");
    }
    this.logs.set(id, { seed: Object.freeze([...seed]), tail: [] });
  }

  async readSession(id: string): Promise<{ events: readonly SessionEvent[] }> {
    const log = this.logs.get(id);
    if (!log?.session || this.ctx.sessions.get(SessionId(id)) !== log.session) {
      throw new Error("companion recall session is unavailable");
    }
    if (log.failure) throw log.failure;
    return { events: Object.freeze([...log.seed, ...log.tail]) };
  }
}
