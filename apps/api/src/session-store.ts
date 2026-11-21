import { randomBytes } from 'node:crypto';

/** Absolute session lifetime: a session ends this long after sign-in whatever its use. */
export const SESSION_ABSOLUTE_TTL_MS = 8 * 60 * 60 * 1000;
/** Idle timeout: a session unused for this long ends. */
export const SESSION_IDLE_TTL_MS = 60 * 60 * 1000;
/** Live sessions one subject (tenant and user) may hold; a new one replaces that subject's oldest. */
export const SESSIONS_PER_SUBJECT = 5;
/** Live sessions one tenant may hold; a new one replaces that tenant's least recently used. */
export const SESSIONS_PER_TENANT = 100;
/**
 * At the global ceiling, only a tenant holding more than this many sessions can lose one to make
 * room. A tenant at or under it is never trimmed by someone else's sign-in.
 */
export const SESSION_TENANT_QUOTA = 20;
/** Global safety ceiling on live sessions, far above the sum of normal use. */
export const SESSIONS_MAX = 10_000;
/** What a refused sign-in is told to wait, in seconds. */
export const SESSION_RETRY_AFTER_S = 60;

export interface SessionRecord {
  tenantId: string;
  subject: string;
  createdAt: number;
  lastSeenAt: number;
}

/**
 * No room for this sign-in: the store is at its global ceiling and every tenant is within its
 * quota. The caller answers 503 with Retry-After.
 */
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
   * Creates a session and returns its id (32 random bytes, base64url). Capacity is per tenant: a
   * subject at its cap loses its own oldest session, a tenant at its cap loses its own least
   * recently used one. At the global ceiling the tenant holding the most sessions loses its least
   * recently used one, but only when it is above its quota; otherwise this throws
   * SessionCapacityError. A sign-in never evicts a session of a tenant within its quota.
   */
  create(tenantId: string, subject: string, now: number): Promise<string>;
  /**
   * The live session for `sid` belonging to `tenantId`, refreshing its idle timer; null when it is
   * unknown, belongs to another tenant, or has passed its absolute or idle expiry (then removed).
   */
  use(sid: string, tenantId: string, now: number): Promise<SessionRecord | null>;
  /** Like `use`, without refreshing the idle timer. Re-checks an open event stream. */
  peek(sid: string, tenantId: string, now: number): Promise<SessionRecord | null>;
  /** Deletes the session only if it belongs to `tenantId`. True when one was deleted. */
  revoke(sid: string, tenantId: string): Promise<boolean>;
}

export const SESSION_ID_RE = /^[A-Za-z0-9_-]{43}$/;

export interface SessionLimits {
  absoluteMs: number;
  idleMs: number;
  /** Global safety ceiling on live sessions. */
  max: number;
  /** Cap per tenant and subject. */
  perSubject: number;
  /** Cap per tenant. */
  perTenant: number;
  /** At the global ceiling, tenants at or under this many sessions are never trimmed. */
  tenantQuota: number;
}

const subjectKey = (tenantId: string, subject: string) => `${tenantId}\u0000${subject}`;

/**
 * In-process SessionStore. Sessions do not survive a restart and are not shared between API
 * instances, so it suits one process (dev, a single-instance pilot). A Postgres-backed store (a
 * `sessions` table with tenant_id and forced RLS in packages/db) is the follow-up for more than
 * one instance; it implements this same interface.
 *
 * Expired sessions are removed lazily (on use), from a tenant's own pool when it is full, by a
 * full sweep whenever the store reaches its ceiling, and by `sweep()` (the app calls it on a
 * timer).
 */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  /** Session ids per subject, oldest first (Set keeps insertion order). */
  private readonly bySubject = new Map<string, Set<string>>();
  /** Session ids per tenant. */
  private readonly byTenant = new Map<string, Set<string>>();
  private readonly limits: SessionLimits;

  constructor(limits: Partial<SessionLimits> = {}) {
    this.limits = {
      absoluteMs: SESSION_ABSOLUTE_TTL_MS,
      idleMs: SESSION_IDLE_TTL_MS,
      max: SESSIONS_MAX,
      perSubject: SESSIONS_PER_SUBJECT,
      perTenant: SESSIONS_PER_TENANT,
      tenantQuota: SESSION_TENANT_QUOTA,
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
    const tset = this.byTenant.get(r.tenantId);
    tset?.delete(sid);
    if (tset && tset.size === 0) this.byTenant.delete(r.tenantId);
  }

  /** Removes the tenant's expired sessions. */
  private expireTenant(tenantId: string, now: number): void {
    for (const sid of [...(this.byTenant.get(tenantId) ?? [])]) {
      const r = this.sessions.get(sid);
      if (r && this.expired(r, now)) this.remove(sid);
    }
  }

  /** Removes the tenant's least recently used session. */
  private evictLeastRecent(tenantId: string): void {
    let victim: string | undefined;
    let seen = Infinity;
    for (const sid of this.byTenant.get(tenantId) ?? []) {
      const r = this.sessions.get(sid);
      if (r && r.lastSeenAt < seen) {
        seen = r.lastSeenAt;
        victim = sid;
      }
    }
    if (victim !== undefined) this.remove(victim);
  }

  /** The tenant holding the most sessions, and how many. */
  private largestTenant(): [string, number] | null {
    let best: [string, number] | null = null;
    for (const [tenantId, set] of this.byTenant) {
      if (!best || set.size > best[1]) best = [tenantId, set.size];
    }
    return best;
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
    // 1. The subject's own expired sessions, then its oldest live ones down to cap - 1.
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
    // 2. The tenant's own pool: its expired sessions, then its least recently used.
    const poolSize = () => this.byTenant.get(tenantId)?.size ?? 0;
    if (poolSize() >= this.limits.perTenant) {
      this.expireTenant(tenantId, now);
      while (poolSize() > 0 && poolSize() >= this.limits.perTenant) {
        this.evictLeastRecent(tenantId);
      }
    }
    // 3. The global ceiling: expired anywhere, then trim the largest tenant if it is over quota.
    if (this.sessions.size >= this.limits.max) this.sweep(now);
    if (this.sessions.size >= this.limits.max) {
      const largest = this.largestTenant();
      if (!largest || largest[1] <= this.limits.tenantQuota) {
        return Promise.reject(new SessionCapacityError());
      }
      this.evictLeastRecent(largest[0]);
    }
    const sid = randomBytes(32).toString('base64url');
    this.sessions.set(sid, { tenantId, subject, createdAt: now, lastSeenAt: now });
    let set = this.bySubject.get(key);
    if (!set) {
      set = new Set();
      this.bySubject.set(key, set);
    }
    set.add(sid);
    let tset = this.byTenant.get(tenantId);
    if (!tset) {
      tset = new Set();
      this.byTenant.set(tenantId, tset);
    }
    tset.add(sid);
    return Promise.resolve(sid);
  }

  private live(sid: string, tenantId: string, now: number): SessionRecord | null {
    const r = this.sessions.get(sid);
    if (!r || r.tenantId !== tenantId) return null;
    if (this.expired(r, now)) {
      this.remove(sid);
      return null;
    }
    return r;
  }

  use(sid: string, tenantId: string, now: number): Promise<SessionRecord | null> {
    const r = this.live(sid, tenantId, now);
    if (!r) return Promise.resolve(null);
    r.lastSeenAt = now;
    return Promise.resolve({ ...r });
  }

  peek(sid: string, tenantId: string, now: number): Promise<SessionRecord | null> {
    const r = this.live(sid, tenantId, now);
    return Promise.resolve(r ? { ...r } : null);
  }

  revoke(sid: string, tenantId: string): Promise<boolean> {
    const r = this.sessions.get(sid);
    if (!r || r.tenantId !== tenantId) return Promise.resolve(false);
    this.remove(sid);
    return Promise.resolve(true);
  }

  /** How many sessions the tenant holds (live or not yet swept). */
  countFor(tenantId: string): number {
    return this.byTenant.get(tenantId)?.size ?? 0;
  }

  /** How many sessions are held (live or not yet swept). */
  get size(): number {
    return this.sessions.size;
  }
}
