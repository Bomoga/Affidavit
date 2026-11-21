import { randomBytes } from 'node:crypto';

/** Absolute session lifetime: a session ends this long after sign-in whatever its use. */
export const SESSION_ABSOLUTE_TTL_MS = 8 * 60 * 60 * 1000;
/** Idle timeout: a session unused for this long ends. */
export const SESSION_IDLE_TTL_MS = 60 * 60 * 1000;
/** Live sessions one subject (tenant and user) may hold; a new one replaces that subject's oldest. */
export const SESSIONS_PER_SUBJECT = 5;
/** Live sessions the whole store may hold; past it new sign-ins are refused, nobody is evicted. */
export const SESSIONS_MAX = 10_000;
/** What a refused sign-in is told to wait, in seconds. */
export const SESSION_RETRY_AFTER_S = 60;

export interface SessionRecord {
  tenantId: string;
  subject: string;
  createdAt: number;
  lastSeenAt: number;
}

/** The store is full of live sessions. The caller answers 503 with Retry-After. */
export class SessionCapacityError extends Error {
  constructor() {
    super('session store is full');
    this.name = 'SessionCapacityError';
  }
}

/**
 * Server-side session state. The cookie carries only a random session id (plus tenant and subject,
 * which must match the record); a session is valid only while its record exists here, so logout
 * and expiry take effect on the server, not just in the browser.
 */
export interface SessionStore {
  /**
   * Creates a session and returns its id (32 random bytes, base64url). A subject at its own cap
   * loses its own oldest session. Throws SessionCapacityError when the store is full; it never
   * evicts another subject's session to make room.
   */
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

export interface SessionLimits {
  absoluteMs: number;
  idleMs: number;
  /** Global cap on live sessions. */
  max: number;
  /** Cap per tenant and subject. */
  perSubject: number;
}

const subjectKey = (tenantId: string, subject: string) => `${tenantId}\u0000${subject}`;

/**
 * In-process SessionStore. Sessions do not survive a restart and are not shared between API
 * instances, so it suits one process (dev, a single-instance pilot). A Postgres-backed store (a
 * `sessions` table with tenant_id and forced RLS in packages/db) is the follow-up for more than
 * one instance; it implements this same interface.
 *
 * Expired sessions are removed lazily (on use), by a full sweep whenever the store reaches its
 * cap, and by `sweep()` (the app calls it on a timer).
 */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  /** Session ids per subject, oldest first (Set keeps insertion order). */
  private readonly bySubject = new Map<string, Set<string>>();
  private readonly limits: SessionLimits;

  constructor(limits: Partial<SessionLimits> = {}) {
    this.limits = {
      absoluteMs: SESSION_ABSOLUTE_TTL_MS,
      idleMs: SESSION_IDLE_TTL_MS,
      max: SESSIONS_MAX,
      perSubject: SESSIONS_PER_SUBJECT,
      ...limits,
    };
  }

  private expired(r: SessionRecord, now: number): boolean {
    return now - r.createdAt >= this.limits.absoluteMs || now - r.lastSeenAt >= this.limits.idleMs;
  }

  private remove(sid: string): void {
    const r = this.sessions.get(sid);
    if (!r) return;
    this.sessions.delete(sid);
    const key = subjectKey(r.tenantId, r.subject);
    const set = this.bySubject.get(key);
    set?.delete(sid);
    if (set && set.size === 0) this.bySubject.delete(key);
  }

  /** Removes every expired session. Returns how many were removed. */
  sweep(now: number): number {
    let n = 0;
    for (const [sid, r] of this.sessions) {
      if (this.expired(r, now)) {
        this.remove(sid);
        n += 1;
      }
    }
    return n;
  }

  create(tenantId: string, subject: string, now: number): Promise<string> {
    const key = subjectKey(tenantId, subject);
    // The subject's own expired sessions first, then its oldest live ones down to cap - 1.
    const own = this.bySubject.get(key);
    if (own) {
      for (const sid of [...own]) {
        const r = this.sessions.get(sid);
        if (r && this.expired(r, now)) this.remove(sid);
      }
      for (const sid of [...own]) {
        if (own.size < this.limits.perSubject) break;
        this.remove(sid);
      }
    }
    if (this.sessions.size >= this.limits.max) this.sweep(now);
    if (this.sessions.size >= this.limits.max) {
      return Promise.reject(new SessionCapacityError());
    }
    const sid = randomBytes(32).toString('base64url');
    this.sessions.set(sid, { tenantId, subject, createdAt: now, lastSeenAt: now });
    let set = this.bySubject.get(key);
    if (!set) {
      set = new Set();
      this.bySubject.set(key, set);
    }
    set.add(sid);
    return Promise.resolve(sid);
  }

  use(sid: string, tenantId: string, now: number): Promise<SessionRecord | null> {
    const r = this.sessions.get(sid);
    if (!r || r.tenantId !== tenantId) return Promise.resolve(null);
    if (this.expired(r, now)) {
      this.remove(sid);
      return Promise.resolve(null);
    }
    r.lastSeenAt = now;
    return Promise.resolve({ ...r });
  }

  revoke(sid: string, tenantId: string): Promise<boolean> {
    const r = this.sessions.get(sid);
    if (!r || r.tenantId !== tenantId) return Promise.resolve(false);
    this.remove(sid);
    return Promise.resolve(true);
  }

  /** How many sessions are held (live or not yet swept). */
  get size(): number {
    return this.sessions.size;
  }
}
