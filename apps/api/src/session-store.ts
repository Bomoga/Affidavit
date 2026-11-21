import { randomBytes } from 'node:crypto';

/** Absolute session lifetime: a session ends this long after sign-in whatever its use. */
export const SESSION_ABSOLUTE_TTL_MS = 8 * 60 * 60 * 1000;
/** Idle timeout: a session unused for this long ends. */
export const SESSION_IDLE_TTL_MS = 60 * 60 * 1000;

export interface SessionRecord {
  tenantId: string;
  subject: string;
  createdAt: number;
  lastSeenAt: number;
}

/**
 * Server-side session state. The cookie carries only a random session id (plus tenant and subject,
 * which must match the record); a session is valid only while its record exists here, so logout
 * and expiry take effect on the server, not just in the browser.
 */
export interface SessionStore {
  /** Creates a session and returns its id: 32 random bytes, base64url. */
  create(tenantId: string, subject: string, now: number): Promise<string>;
  /**
   * The live session for `sid` belonging to `tenantId`, refreshing its idle timer; null when it is
   * unknown, belongs to another tenant, or has passed its absolute or idle expiry (then removed).
   */
  use(sid: string, tenantId: string, now: number): Promise<SessionRecord | null>;
  /** Deletes the session only if it belongs to `tenantId`. True when one was deleted. */
  revoke(sid: string, tenantId: string): Promise<boolean>;
}

export const SESSION_ID_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * In-process SessionStore. Sessions do not survive a restart and are not shared between API
 * instances, so it suits one process (dev, a single-instance pilot). A Postgres-backed store (a
 * `sessions` table with tenant_id and forced RLS in packages/db) is the follow-up for more than
 * one instance; it implements this same interface.
 */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(
    private readonly limits: { absoluteMs: number; idleMs: number; max: number } = {
      absoluteMs: SESSION_ABSOLUTE_TTL_MS,
      idleMs: SESSION_IDLE_TTL_MS,
      max: 10_000,
    },
  ) {}

  private expired(r: SessionRecord, now: number): boolean {
    return now - r.createdAt >= this.limits.absoluteMs || now - r.lastSeenAt >= this.limits.idleMs;
  }

  create(tenantId: string, subject: string, now: number): Promise<string> {
    if (this.sessions.size >= this.limits.max) {
      for (const [k, r] of this.sessions) if (this.expired(r, now)) this.sessions.delete(k);
      // Still full: drop the oldest so a flood of sign-ins cannot grow memory without bound.
      if (this.sessions.size >= this.limits.max) {
        const oldest = this.sessions.keys().next().value;
        if (oldest !== undefined) this.sessions.delete(oldest);
      }
    }
    const sid = randomBytes(32).toString('base64url');
    this.sessions.set(sid, { tenantId, subject, createdAt: now, lastSeenAt: now });
    return Promise.resolve(sid);
  }

  use(sid: string, tenantId: string, now: number): Promise<SessionRecord | null> {
    const r = this.sessions.get(sid);
    if (!r || r.tenantId !== tenantId) return Promise.resolve(null);
    if (this.expired(r, now)) {
      this.sessions.delete(sid);
      return Promise.resolve(null);
    }
    r.lastSeenAt = now;
    return Promise.resolve({ ...r });
  }

  revoke(sid: string, tenantId: string): Promise<boolean> {
    const r = this.sessions.get(sid);
    if (!r || r.tenantId !== tenantId) return Promise.resolve(false);
    this.sessions.delete(sid);
    return Promise.resolve(true);
  }

  /** Test helper: how many sessions are held. */
  get size(): number {
    return this.sessions.size;
  }
}
