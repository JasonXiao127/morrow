/**
 * Per-OpenCode-session quotas (plan §6).
 *
 * - 10 writes per run
 * - 20 proposal operations (including operations already pending)
 * - 30 tool calls per minute
 *
 * The tracker is in-memory by design: it is a blast-radius limiter, not an
 * audit ledger. Every write is separately recorded in `activity`.
 */
import { AgentError } from "./types.js";

export const DEFAULT_QUOTAS = {
  writesPerRun: 10,
  proposalOperations: 20,
  toolCallsPerMinute: 30,
  /** A run that never gets an explicit begin() expires after this window. */
  staleRunMs: 30 * 60 * 1000,
} as const;

interface SessionQuota {
  runStartedAt: number;
  writes: number;
  callTimes: number[];
}

export class QuotaTracker {
  private readonly sessions = new Map<string, SessionQuota>();
  private readonly limits: {
    writesPerRun: number;
    proposalOperations: number;
    toolCallsPerMinute: number;
    staleRunMs: number;
  };

  constructor(limits: Partial<typeof DEFAULT_QUOTAS> = {}) {
    this.limits = { ...DEFAULT_QUOTAS, ...limits };
  }

  /** Called by the app when a user prompt is enqueued. */
  beginRun(sessionKey: string, now = Date.now()): void {
    this.sessions.set(sessionKey, {
      runStartedAt: now,
      writes: 0,
      callTimes: this.sessions.get(sessionKey)?.callTimes ?? [],
    });
  }

  private session(sessionKey: string, now: number): SessionQuota {
    const existing = this.sessions.get(sessionKey);
    if (existing && now - existing.runStartedAt <= this.limits.staleRunMs) {
      return existing;
    }
    const fresh: SessionQuota = {
      runStartedAt: now,
      writes: 0,
      callTimes: existing?.callTimes ?? [],
    };
    this.sessions.set(sessionKey, fresh);
    return fresh;
  }

  /** Throws when the per-minute tool-call budget is exhausted. */
  checkToolCall(sessionKey: string, now = Date.now()): void {
    const session = this.session(sessionKey, now);
    const cutoff = now - 60_000;
    session.callTimes = session.callTimes.filter((at) => at > cutoff);
    if (session.callTimes.length >= this.limits.toolCallsPerMinute) {
      throw new AgentError(
        "quota_tool_calls",
        `Tool-call quota exhausted (${this.limits.toolCallsPerMinute}/minute). Ask the user to retry shortly.`,
        429,
      );
    }
    session.callTimes.push(now);
  }

  /** Reserve one immediate write in the current run. */
  checkWrite(sessionKey: string, now = Date.now()): void {
    const session = this.session(sessionKey, now);
    if (session.writes >= this.limits.writesPerRun) {
      throw new AgentError(
        "quota_writes",
        `Write quota exhausted (${this.limits.writesPerRun} per run). Use reminders_propose for the remaining changes.`,
        429,
      );
    }
    session.writes += 1;
  }

  /**
   * Validate a proposal's operation count against both this request and the
   * operations already pending for the same conversation.
   */
  checkProposalOps(
    sessionKey: string,
    requested: number,
    alreadyPending: number,
    now = Date.now(),
  ): void {
    const session = this.session(sessionKey, now);
    if (!Number.isInteger(requested) || requested < 1) {
      throw new AgentError("quota_proposal", "A proposal needs at least one operation.", 400);
    }
    if (
      requested > this.limits.proposalOperations ||
      alreadyPending + requested > this.limits.proposalOperations
    ) {
      throw new AgentError(
        "quota_proposal",
        `Proposal quota exhausted (${this.limits.proposalOperations} operations, pending proposals included). Apply or dismiss pending proposals first.`,
        429,
      );
    }
    void session;
  }

  snapshot(sessionKey: string): {
    writes: number;
    toolCallsLastMinute: number;
  } {
    const session = this.sessions.get(sessionKey);
    const cutoff = Date.now() - 60_000;
    return {
      writes: session?.writes ?? 0,
      toolCallsLastMinute:
        session?.callTimes.filter((at) => at > cutoff).length ?? 0,
    };
  }

  reset(sessionKey?: string): void {
    if (sessionKey) this.sessions.delete(sessionKey);
    else this.sessions.clear();
  }
}

/** Process-wide tracker used by MCP and the assistant API. */
export const quotas = new QuotaTracker();
