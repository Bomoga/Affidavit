/**
 * Turns the router events the interpreter recorded into a flat route table: mounted routers get
 * their prefixes, `use` middleware is carried in front of the routes registered after it, and
 * every middleware is classified (repo function, known package, unresolved; auth guard or not).
 */
import type { FnInfo } from './prepass.js';
import { fnRef } from './prepass.js';
import type { AstNode } from './parse.js';
import type { HandlerRef, InterpOutput, RouterEvent, RouterObj } from './engine.js';
import type { ChainItem, MapRoute, RouteMount } from './types.js';
import type { FnValue, PathVal, Value } from './values.js';

/** A route plus the function ids that run in front of and at the end of it. */
export interface FlatRoute extends MapRoute {
  /**
   * `route`: a method and path. `use`: a middleware or error handler registered with `use`; it
   * runs for requests, so it is a reachability entry, but it is not listed as a route.
   */
  kind: 'route' | 'use';
  /** Functions of every chain item and the handler, for reachability. */
  entryFns: number[];
}

export const MAX_ROUTES = 20_000;
const MAX_WORK = 400_000;

const BENIGN_PACKAGES = new Set([
  'body-parser',
  'express',
  'express-session',
  'cookie-session',
  'cookie-parser',
  'serve-favicon',
  'serve-static',
  'cors',
  'helmet',
  'morgan',
  'compression',
  'csurf',
  'multer',
  'method-override',
  'errorhandler',
  'connect-flash',
  'express-rate-limit',
  'consolidate',
  'swig',
  'marked',
]);

const AUTH_NAME =
  /(loggedin|logged_in|isauth|authenticat|authoriz|requireslogin|requirelogin|ensurelogin|requiresauth|requireauth|ensureauth|requireuser|checkauth|verifytoken|verifyjwt|jwt|isadmin|requireadmin|ensureadmin|isowner|checkrole|requirerole|hasrole)/i;
const AUTH_BARE = /(^|[._])auth(\(\))?$/i;

/** Name-based guess: does this middleware label look like an authentication check? */
export function looksLikeAuthName(label: string): boolean {
  if (/^passport\.(initialize|session)\(/i.test(label)) return false;
  if (/^(express-)?session\(/i.test(label)) return false;
  return AUTH_NAME.test(label) || AUTH_BARE.test(label);
}

function chainText(n: AstNode | undefined, depth = 0): string | undefined {
  if (!n || depth > 8) return undefined;
  if (n.t === 'identifier' || n.t === 'property_identifier') return n.x;
  if (n.t === 'this') return 'this';
  if (n.t === 'member_expression') {
    const o = chainText(n.f['object'], depth + 1);
    const p = n.f['property']?.x;
    return o !== undefined && p !== undefined ? `${o}.${p}` : undefined;
  }
  if (n.t === 'call_expression') return chainText(n.f['function'], depth + 1);
  return undefined;
}

/** Chains that say who the caller is. An Authorization header is deliberately not here: its
 * presence says nothing about whether the credential was checked. */
const IDENTITY_CHAIN = [
  /^(req|request)\.session\.(userid|user|id|loggedin|isloggedin|passport|uid)$/i,
  /^(req|request)\.user$/i,
  /^ctx\.state\.user$/i,
  /^(req|request)\.isAuthenticated$/i,
];

const unwrap = (n: AstNode | undefined): AstNode | undefined => {
  let x = n;
  while (x && (x.t === 'parenthesized_expression' || x.t === 'await_expression')) x = x.c[0];
  return x;
};

const isIdentityAtom = (n: AstNode | undefined): boolean => {
  const x = unwrap(n);
  if (!x) return false;
  if (x.t === 'call_expression' && (x.f['arguments']?.c.length ?? 0) > 0) return false;
  const t = chainText(x);
  return t !== undefined && IDENTITY_CHAIN.some((re) => re.test(t));
};

/** `pos`: the condition is true when the caller is known; `neg`: true when not. Only a single
 * identity read (optionally negated) qualifies: anything mixed with another test does not. */
function polarity(n: AstNode | undefined): 'pos' | 'neg' | undefined {
  const x = unwrap(n);
  if (!x) return undefined;
  if (x.t === 'unary_expression' && x.op === '!') {
    const inner = polarity(x.c[0]);
    return inner === 'pos' ? 'neg' : inner === 'neg' ? 'pos' : undefined;
  }
  return isIdentityAtom(x) ? 'pos' : undefined;
}

function walkAll(
  n: AstNode,
  visit: (x: AstNode) => void,
  budget = { left: 20_000 },
  depth = 0,
): void {
  if (budget.left-- <= 0 || depth > 120) return;
  visit(n);
  for (const c of n.c) walkAll(c, visit, budget, depth + 1);
}

const isCallTo = (n: AstNode | undefined, name: string): boolean => {
  const x = unwrap(n);
  return (
    x?.t === 'call_expression' && x.f['function']?.t === 'identifier' && x.f['function'].x === name
  );
};

function isDenyExpr(n: AstNode | undefined): boolean {
  let found = false;
  if (n) {
    walkAll(n, (x) => {
      if (x.t !== 'call_expression') return;
      const last = (chainText(x.f['function']) ?? '').split('.').pop() ?? '';
      const arg = x.f['arguments']?.c[0]?.x ?? '';
      if (last === 'redirect' || last === 'unauthorized' || last === 'forbidden') found = true;
      if ((last === 'status' || last === 'sendStatus') && /^(401|403)$/.test(arg)) found = true;
    });
  }
  return found;
}

const refCount = (n: AstNode, name: string): number => {
  let count = 0;
  walkAll(n, (x) => {
    if (x.t === 'identifier' && x.x === name) count++;
  });
  return count;
};

/** The statement ends the function by denying (a returned deny call, or a throw). */
function endsInDeny(s: AstNode | undefined, next: string): boolean {
  if (!s) return false;
  if (s.t === 'return_statement') return isDenyExpr(s.c[0]) && refCount(s, next) === 0;
  if (s.t === 'throw_statement') return true;
  if (s.t === 'statement_block')
    return endsInDeny(s.c[s.c.length - 1], next) && refCount(s, next) === 0;
  return false;
}

/** The statement ends the function by calling `next(...)` and returning. */
function endsInNext(s: AstNode | undefined, next: string): boolean {
  if (!s) return false;
  if (s.t === 'return_statement') return isCallTo(s.c[0], next);
  if (s.t === 'statement_block') {
    const last = s.c[s.c.length - 1];
    const before = s.c[s.c.length - 2];
    if (last?.t === 'return_statement') {
      if (isCallTo(last.c[0], next)) return true;
      return (
        last.c.length === 0 && before?.t === 'expression_statement' && isCallTo(before.c[0], next)
      );
    }
  }
  return false;
}

/**
 * Body-based verdict on a middleware, strict on purpose. `guard` only for these shapes, where
 * `next` is the function's third parameter, is called exactly once and is never aliased or
 * passed on, there is no try/catch, and the test is one identity read (`req.user`,
 * `req.session.userId`, `req.isAuthenticated()`, `ctx.state.user`), optionally negated:
 *   if (id) return next(); <deny>          if (!id) <deny>; return next();
 *   if (id) return next(); else <deny>     if (!id) <deny> else return next();
 *   id ? next() : <deny>                   (arrow with an expression body)
 * where <deny> returns (or throws) a redirect, 401 or 403. Anything else that reads an identity,
 * can deny and can call `next` is `uncertain`; the rest is `no`.
 */
export function bodyLooksLikeAuthGuard(fn: FnInfo): 'guard' | 'uncertain' | 'no' {
  const body = fn.node.f['body'];
  if (!body) return 'no';
  // The loose evidence: reads, denies and passes somewhere in the body.
  let reads = false;
  let denies = false;
  let passes = false;
  let hasTry = false;
  walkAll(body, (n) => {
    if (n.t === 'member_expression') {
      const t = chainText(n);
      if (
        t &&
        (IDENTITY_CHAIN.some((re) => re.test(t)) ||
          /^(req|request)\.(user|auth|headers\.authorization)/i.test(t) ||
          /^ctx\.state\.user/i.test(t))
      ) {
        reads = true;
      }
    }
    if (n.t === 'call_expression') {
      const t = chainText(n.f['function']) ?? '';
      if (/^(next|done|cb|callback)$/.test(t)) passes = true;
    }
    if (n.t === 'throw_statement') denies = true;
    if (n.t === 'try_statement') hasTry = true;
  });
  if (isDenyExpr(body)) denies = true;
  const params = fn.node.f['parameters']?.c ?? [];
  const third = params[2];
  const nextName = third?.t === 'identifier' ? third.x : third?.f['pattern']?.x;
  // `next` aliased or handed to a helper still lets the request through.
  if (nextName && refCount(body, nextName) > 0) passes = true;
  if (!reads || !denies || !passes) return 'no';
  if (!nextName || hasTry || refCount(body, nextName) !== 1) return 'uncertain';

  if (body.t !== 'statement_block') {
    const t = unwrap(body);
    if (t?.t === 'ternary_expression') {
      const [cond, a, b] = t.c;
      const pol = polarity(cond);
      const ok =
        pol === 'pos'
          ? isCallTo(a, nextName) && isDenyExpr(b)
          : pol === 'neg'
            ? isDenyExpr(a) && isCallTo(b, nextName)
            : false;
      return ok ? 'guard' : 'uncertain';
    }
    return 'uncertain';
  }
  const stmts = body.c;
  const at = stmts.findIndex((s) => s.t === 'if_statement');
  const ifs = stmts[at];
  if (!ifs) return 'uncertain';
  const pol = polarity(ifs.f['condition']);
  const alt =
    ifs.f['alternative']?.t === 'else_clause' ? ifs.f['alternative'].c[0] : ifs.f['alternative'];
  const rest = stmts.slice(at + 1);
  const cons = ifs.f['consequence'];
  const lastRest = rest[rest.length - 1];
  const before = stmts.slice(0, at);
  if (before.some((s) => refCount(s, nextName) > 0 || isDenyExpr(s))) return 'uncertain';
  if (pol === 'pos') {
    if (!endsInNext(cons, nextName)) return 'uncertain';
    if (alt)
      return endsInDeny(alt, nextName) && rest.every((s) => refCount(s, nextName) === 0)
        ? 'guard'
        : 'uncertain';
    return endsInDeny(lastRest, nextName) && rest.length >= 1 ? 'guard' : 'uncertain';
  }
  if (pol === 'neg') {
    if (!endsInDeny(cons, nextName)) return 'uncertain';
    if (alt) return endsInNext(alt, nextName) ? 'guard' : 'uncertain';
    const lastIsNext =
      lastRest !== undefined &&
      ((lastRest.t === 'return_statement' && isCallTo(lastRest.c[0], nextName)) ||
        (lastRest.t === 'expression_statement' && isCallTo(lastRest.c[0], nextName)));
    return lastIsNext && rest.length === 1 ? 'guard' : 'uncertain';
  }
  return 'uncertain';
}

const joinPath = (a: string, b: string): string => {
  const joined = `${a}/${b}`.replace(/\/{2,}/g, '/');
  const withLead = joined.startsWith('/') ? joined : `/${joined}`;
  return withLead.length > 1 ? withLead.replace(/\/+$/, '') || '/' : withLead;
};

const MAX_PATH = 200;

/** Joins and caps; a cut path is no longer the real path, so it counts as dynamic. */
const joinCapped = (a: string, b: string): { text: string; cut: boolean } => {
  const j = joinPath(a, b);
  return j.length > MAX_PATH ? { text: j.slice(0, MAX_PATH), cut: true } : { text: j, cut: false };
};

/** Output form of a path: URL path characters only (plus the `${name}` marker). */
const outPath = (s: string): string => s.replace(/[^A-Za-z0-9\-._~!$&()*+,;=:@%/{}[\]?]/g, '_');

const covers = (scope: string, full: string, dynamic: boolean): boolean => {
  if (dynamic || scope === '/') return true;
  return full === scope || full.startsWith(`${scope}/`);
};

interface Pending {
  item: ChainItem;
  /** Joined path the middleware is limited to, or null for all routes under the router. */
  scopePath: string | null;
  scopeDynamic: boolean;
  fnIds: number[];
}

const SKIPPED_LABEL = /[^A-Za-z0-9_$.()<>[\]-]/g;
const cleanLabel = (s: string): string => s.replace(SKIPPED_LABEL, '_').slice(0, 80);

/** Builds the route table. `facts` supplies function bodies for the auth guard check. */
export function buildRoutes(
  out: InterpOutput,
  deadline: number,
): { routes: FlatRoute[]; truncated: boolean; timedOut: boolean } {
  const routes: FlatRoute[] = [];
  let truncated = false;
  /** Routers walked at least once (for finding the ones nothing mounts). */
  const visited = new Set<number>();
  /** Routers on the current mount path, so a mount cycle ends. */
  const onStack = new Set<number>();
  const guardCache = new Map<number, 'guard' | 'uncertain' | 'no'>();
  /** Work counter for the walk: mounts can branch, so the walk has a budget and a deadline. */
  let work = 0;
  let stopped = false;
  let timedOut = false;
  const walked = new Set<string>();
  const authUnsure = out.limitsHit.has('value-set-cap');
  /** The same registration reached twice (a function run with different arguments) counts once. */
  const seen = new Set<string>();
  const pushRoute = (r: FlatRoute): void => {
    const key = `${r.kind}|${r.mounted}|${r.route.method}|${r.route.path}|${r.file}|${r.line}|${r.handlerLabel}`;
    if (seen.has(key)) return;
    seen.add(key);
    routes.push(r);
  };

  const bodyGuard = (fn: FnInfo): 'guard' | 'uncertain' | 'no' => {
    let g = guardCache.get(fn.id);
    if (g === undefined) {
      g = bodyLooksLikeAuthGuard(fn);
      guardCache.set(fn.id, g);
    }
    return g;
  };

  const toItem = (ref: HandlerRef, scope: ChainItem['scope'], final = false): Pending => {
    const closures = ref.vals.filter((v): v is FnValue => v.k === 'fn');
    const first = closures[0];
    let authGuard: ChainItem['authGuard'];
    let authUncertain = false;
    let authNone = false;
    // The last function is the handler: whether it checks the caller inline is not middleware.
    if (!final) {
      const nameHit = looksLikeAuthName(ref.label);
      if (closures.length > 0) {
        // Repo code: only what the body does counts, never what it is called.
        const verdicts = closures.map((c) => bodyGuard(c.fn));
        if (verdicts.every((v) => v === 'guard')) authGuard = 'body';
        else if (nameHit || verdicts.some((v) => v !== 'no')) authUncertain = true;
      } else if (ref.strategy === 'anonymous-only') {
        authNone = true;
      } else if (nameHit || ref.strategy !== undefined) {
        // A package's middleware: the name is the evidence, unless its options can turn it off
        // or cannot be read (a variable, a spread, a computed key) or it may be `anonymous`.
        if (ref.optional || ref.strategy === 'uncertain' || /\.unless\b/.test(ref.label)) {
          authUncertain = true;
        } else authGuard = 'name';
      }
    }
    const item: ChainItem = {
      label: cleanLabel(ref.label),
      scope,
      file: ref.file,
      line: ref.line,
      external: ref.external,
      unresolved: ref.unresolved,
    };
    if (first) item.fn = fnRef(first.fn);
    if (authGuard) item.authGuard = authGuard;
    if (authUncertain) item.authUncertain = true;
    if (authNone) item.authNone = true;
    return {
      item,
      scopePath: null,
      scopeDynamic: false,
      fnIds: closures.map((c) => c.fn.id),
    };
  };

  const walk = (
    router: RouterObj,
    prefix: string,
    inherited: Pending[],
    mounted: RouteMount,
    isRootApp: boolean,
  ): void => {
    if (onStack.has(router.id) || stopped) return;
    const sigKey = `${router.id}|${prefix}|${mounted}|${inherited
      .map(
        (c) =>
          `${c.item.label}@${c.scopePath ?? ''}${c.scopeDynamic ? '~' : ''}:${c.fnIds.join(',')}`,
      )
      .join(';')}`;
    if (walked.has(sigKey)) return;
    walked.add(sigKey);
    visited.add(router.id);
    onStack.add(router.id);
    try {
      walkEvents(router, prefix, inherited, mounted, isRootApp);
    } finally {
      onStack.delete(router.id);
    }
  };

  const authOf = (apps: Pending[], dynamic: boolean, extraUnsure: boolean): boolean | 'unknown' => {
    let certain = false;
    let unsure = extraUnsure || authUnsure;
    for (const a of apps) {
      const i = a.item;
      const scopeUnsure = a.scopePath !== null && (a.scopeDynamic || dynamic);
      if (i.authGuard) {
        if (scopeUnsure) unsure = true;
        else certain = true;
      }
      if (
        i.unresolved ||
        i.authUncertain ||
        (i.external && !i.authGuard && !i.authNone && !benignItem(i))
      ) {
        unsure = true;
      }
    }
    return certain ? true : unsure ? 'unknown' : false;
  };

  const emitUse = (
    p: Pending,
    ev: Extract<RouterEvent, { kind: 'use' }>,
    full: string,
    dynamic: boolean,
    before: Pending[],
    mounted: RouteMount,
  ): void => {
    if (p.fnIds.length === 0 || routes.length >= MAX_ROUTES) return;
    const applicable = before.filter((c) =>
      c.scopePath === null ? true : covers(c.scopePath, full, c.scopeDynamic || dynamic),
    );
    const items = applicable.map((a) => a.item);
    const first = ev.items[0]?.vals.find((v): v is FnValue => v.k === 'fn');
    const authRequired = authOf(applicable, dynamic, false);
    const route: FlatRoute = {
      kind: 'use',
      route: {
        method: 'USE',
        path: outPath(full),
        handlerFile: first?.fn.file ?? ev.file,
        middleware: items.filter((i) => i.scope !== 'app').map((i) => i.label),
        authRequired,
      },
      appMiddleware: items.filter((i) => i.scope === 'app').map((i) => i.label),
      chain: items,
      handlerLabel: p.item.label,
      pathDynamic: dynamic,
      mounted,
      file: ev.file,
      line: ev.line,
      entryFns: [...applicable.flatMap((a) => a.fnIds), ...p.fnIds],
    };
    if (first) route.handler = fnRef(first.fn);
    pushRoute(route);
  };

  const walkEvents = (
    router: RouterObj,
    prefix: string,
    inherited: Pending[],
    mounted: RouteMount,
    isRootApp: boolean,
  ): void => {
    let chain = inherited.slice();
    const events: RouterEvent[] = router.events.slice().sort((a, b) => a.seq - b.seq);
    for (const ev of events) {
      if (routes.length >= MAX_ROUTES || ++work > MAX_WORK) {
        truncated = true;
        stopped = true;
        return;
      }
      if ((work & 255) === 0 && Date.now() > deadline) {
        truncated = true;
        timedOut = true;
        stopped = true;
        return;
      }
      if (ev.kind === 'use') {
        for (const item of ev.items) {
          const scoped = ev.paths && !(ev.paths.length === 1 && ev.paths[0]?.text === '/');
          const scope: ChainItem['scope'] = scoped ? 'mount' : isRootApp ? 'app' : 'router';
          const p = toItem(item, scope);
          if (scoped && ev.paths) {
            for (const pv of ev.paths) {
              const j = joinCapped(prefix, pv.text);
              emitUse(p, ev, j.text, pv.dynamic || j.cut, chain, mounted);
              chain = chain.concat({
                ...p,
                scopePath: j.text,
                scopeDynamic: pv.dynamic || j.cut,
              });
            }
          } else {
            emitUse(p, ev, prefix === '' ? '/' : prefix, false, chain, mounted);
            chain = chain.concat(p);
          }
        }
      } else if (ev.kind === 'mount') {
        const child = out.routers[ev.child];
        if (!child) continue;
        const paths: PathVal[] = ev.paths ?? [{ text: '/', dynamic: false }];
        for (const pv of paths) {
          const j = joinCapped(prefix, pv.text);
          // A cut prefix is only part of the real one: nothing below it can be trusted as exact.
          walk(
            child,
            j.text,
            j.cut ? chain.map((c) => ({ ...c, scopeDynamic: true })) : chain,
            mounted,
            false,
          );
        }
      } else {
        for (const pv of ev.paths) {
          const j = joinCapped(prefix, pv.text);
          const full = j.text;
          const dyn = pv.dynamic || j.cut;
          const applicable = chain.filter((c) =>
            c.scopePath === null ? true : covers(c.scopePath, full, c.scopeDynamic || dyn),
          );
          const handlerRef = ev.handlers[ev.handlers.length - 1];
          const mws = ev.handlers.slice(0, -1).map((h) => toItem(h, 'route'));
          const all = [...applicable, ...mws];
          const items = all.map((a) => a.item);
          const handler = handlerRef ? toItem(handlerRef, 'route', true) : undefined;
          const hv = handlerRef?.vals.find((v): v is FnValue => v.k === 'fn');
          const handlerFile = hv?.fn.file ?? ev.file;
          const nonApp = items.filter((i) => i.scope !== 'app');
          const authRequired = authOf(all, dyn, !handler || handler.item.unresolved);
          const route: FlatRoute = {
            kind: 'route',
            route: {
              method: ev.method,
              path: outPath(full),
              handlerFile,
              middleware: nonApp.map((i) => i.label),
              authRequired,
            },
            appMiddleware: items.filter((i) => i.scope === 'app').map((i) => i.label),
            chain: items,
            handlerLabel: handler ? handler.item.label : '<none>',
            pathDynamic: dyn,
            mounted,
            file: ev.file,
            line: ev.line,
            entryFns: [...all.flatMap((a) => a.fnIds), ...(handler ? handler.fnIds : [])],
          };
          if (hv) route.handler = fnRef(hv.fn);
          pushRoute(route);
          if (routes.length >= MAX_ROUTES) {
            truncated = true;
            return;
          }
        }
      }
    }
  };

  // Chain items are classified as benign by package name through the HandlerRef values; keep a
  // label set of the benign ones seen so `opaque` can tell them apart.
  const benignLabels = new Set<string>();
  for (const r of out.routers) {
    for (const ev of r.events) {
      const refs = ev.kind === 'route' ? ev.handlers : ev.kind === 'use' ? ev.items : [];
      for (const h of refs) {
        const ext = h.vals.find((v): v is Extract<Value, { k: 'ext' }> => v.k === 'ext');
        if (ext && BENIGN_PACKAGES.has(ext.pkg)) benignLabels.add(cleanLabel(h.label));
      }
    }
  }
  const benignItem = (i: ChainItem): boolean => benignLabels.has(i.label);

  for (const r of out.routers) {
    if (r.kind === 'app') walk(r, '', [], 'app', true);
  }
  for (const r of out.routers) {
    if (r.kind === 'router' && !visited.has(r.id)) walk(r, '', [], 'unmounted', false);
  }
  for (const r of out.routers) {
    if (r.kind === 'orphan') walk(r, '', [], 'orphan', false);
  }
  return { routes, truncated, timedOut };
}
