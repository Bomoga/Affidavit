/**
 * The interpreter behind the map. It is an abstract interpreter over the copied syntax trees, not
 * a runtime: no repo code is ever run, `require` only resolves to files already in the analysis
 * set, and every loop, recursion and value set is bounded.
 *
 * What it tracks, and what it approximates, is documented in packages/discovery/CLAUDE.md. In
 * short: values are sets of abstract things (strings, objects, closures, Express routers,
 * external packages); branches are all taken; loops run once (except `for...of` over a literal
 * array of strings, which runs once per element); calls to repo functions are inlined with the
 * argument values (memoized by argument shape); function literals passed to any call are queued
 * and analyzed later with unknown parameters.
 */
import { posix } from 'node:path';
import type { AstNode } from './parse.js';
import { keyName, plainString, safeIdent, type FileFacts, type FnInfo } from './prepass.js';
import type { DataAccessCall, Leak, LimitHit, MapLimits } from './types.js';
import {
  capHit,
  Scope,
  sig,
  union,
  type ArrValue,
  type ClassMember,
  type ExtValue,
  type FnValue,
  type ObjValue,
  type PathVal,
  type RouteValue,
  type RouterValue,
  type Value,
} from './values.js';
import { fnRef } from './prepass.js';

export interface HandlerRef {
  label: string;
  vals: Value[];
  file: string;
  line: number;
  /** Nothing tracked: neither repo code nor a known package. */
  unresolved: boolean;
  /** At least one value is a third-party package member. */
  external: boolean;
  /** The argument has options that make a check optional (`credentialsRequired`, `.unless`). */
  optional: boolean;
}

export type RouterEvent =
  | {
      seq: number;
      kind: 'route';
      method: string;
      paths: PathVal[];
      handlers: HandlerRef[];
      file: string;
      line: number;
    }
  | {
      seq: number;
      kind: 'use';
      paths: PathVal[] | null;
      items: HandlerRef[];
      file: string;
      line: number;
    }
  | {
      seq: number;
      kind: 'mount';
      paths: PathVal[] | null;
      child: number;
      file: string;
      line: number;
    };

export interface RouterObj {
  id: number;
  kind: 'app' | 'router' | 'orphan';
  file: string;
  line: number;
  events: RouterEvent[];
}

interface ModuleRec {
  file: string;
  moduleObj: ObjValue;
  exportsObj: ObjValue;
  fn: FnInfo;
  state: 'running' | 'done';
}

interface Frame {
  facts: FileFacts;
  fn: FnInfo;
  scope: Scope;
  thisVals: Value[];
  returns: Value[];
  mod: ModuleRec;
  depth: number;
  /** The class whose constructor is running, for `super(...)`. */
  cls?: FnValue;
}

class Abort extends Error {
  constructor(readonly limit: LimitHit) {
    super(limit);
  }
}

const ROUTER_PKGS = new Set(['express', 'express-promise-router', 'router']);
const VERBS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'all']);
const SQL_PKGS = new Set([
  'mysql',
  'mysql2',
  'pg',
  'pg-promise',
  'sqlite3',
  'sqlite',
  'better-sqlite3',
  'knex',
  'sequelize',
  'typeorm',
  'mssql',
  'oracledb',
  '@prisma/client',
  'slonik',
  'postgres',
  'sql.js',
]);
const MONGO_METHODS = new Set([
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'findById',
  'findByIdAndUpdate',
  'findByIdAndDelete',
  'updateOne',
  'updateMany',
  'update',
  'deleteOne',
  'deleteMany',
  'remove',
  'insert',
  'insertOne',
  'insertMany',
  'replaceOne',
  'aggregate',
  'count',
  'countDocuments',
  'distinct',
  'bulkWrite',
  'mapReduce',
  'where',
  'create',
]);
const SQL_METHODS = new Set([
  'query',
  'execute',
  'raw',
  'exec',
  'run',
  'all',
  'get',
  'prepare',
  'queryRawUnsafe',
  'executeRawUnsafe',
  '$queryRawUnsafe',
  '$executeRawUnsafe',
]);
/** Callees that take an Express app and add no routes of their own. */
const BENIGN_ROUTER_SINKS = new Set(['http', 'https', 'http2', 'supertest', 'serverless-http']);
const COMMAND_FNS = new Set(['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync']);
const COLL_NAME = /(col|coll|collection|collections|model|models)$/i;
const SQL_RECEIVER = /^(db|pool|client|conn|connection|knex|sequelize|database|sql|mysql|pg|cnx)$/i;
const ROUTERISH = /(^|[^a-z])(app|router|routes?|api|server)$|(App|Router|Routes?|Api|Server)$/;
const MODULE_EXT = ['', '.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx', '.mts', '.cts'];

const lineOf = (n: AstNode): number => n.r;

/** Source form of an argument, restricted to identifier characters; never free text. */
export function labelOf(n: AstNode | undefined, depth = 0): string {
  if (!n || depth > 6) return '<expr>';
  let s: string;
  switch (n.t) {
    case 'identifier':
    case 'property_identifier':
      s = n.x ?? '<expr>';
      break;
    case 'this':
      s = 'this';
      break;
    case 'member_expression':
      s = `${labelOf(n.f['object'], depth + 1)}.${labelOf(n.f['property'], depth + 1)}`;
      break;
    case 'subscript_expression':
      s = `${labelOf(n.f['object'], depth + 1)}[]`;
      break;
    case 'call_expression':
      s = `${labelOf(n.f['function'], depth + 1)}()`;
      break;
    case 'await_expression':
    case 'parenthesized_expression':
    case 'as_expression':
    case 'non_null_expression':
    case 'satisfies_expression':
      s = labelOf(n.c[0], depth + 1);
      break;
    case 'arrow_function':
    case 'function_expression':
    case 'function':
    case 'generator_function':
      s = n.f['name']?.x ?? '<anonymous>';
      break;
    case 'array':
      s = '<array>';
      break;
    case 'string':
    case 'template_string':
      s = '<string>';
      break;
    default:
      s = '<expr>';
  }
  return safeIdent(s);
}

const OPTIONAL_KEYS = new Set([
  'credentialsRequired',
  'required',
  'optional',
  'passthrough',
  'unless',
  'skip',
  'ignore',
  'exclude',
]);

/** True when a middleware argument carries options that can switch its check off. */
function looksOptional(n: AstNode | undefined): boolean {
  let budget = 400;
  const walk = (x: AstNode, depth: number): boolean => {
    if (budget-- <= 0) return true;
    if (depth > 12) return true;
    if (x.t === 'pair' && OPTIONAL_KEYS.has(keyName(x.f['key']) ?? '')) return true;
    if (x.t === 'property_identifier' && x.x === 'unless') return true;
    return x.c.some((c) => walk(c, depth + 1));
  };
  return n !== undefined && walk(n, 0);
}

export interface InterpOutput {
  routers: RouterObj[];
  edges: Map<number, Set<number>>;
  edgeCount: number;
  sinks: DataAccessCall[];
  leaks: Leak[];
  limitsHit: Set<LimitHit>;
  /** Files whose interpretation was cut short (stack overflow, abort). */
  incompleteFiles: Map<string, Set<'interpreter-aborted' | 'stack-overflow'>>;
  /** Files required by a literal specifier from another analyzed file, with the requirers. */
  requiredBy: Map<string, Set<string>>;
  /** Functions entered by the interpreter (executed at least once). */
  executed: Set<number>;
  /**
   * Functions handed to a call the map could not resolve to repo code (a package, or an untracked
   * value): `[from, to]`. The package may invoke `to` at any time, for example as a request
   * handler of a framework the map does not model.
   */
  handoffs: [number, number][];
}

export class Interpreter {
  private nextValueId = 1;
  private seq = 0;
  private steps = 0;
  private readonly modules = new Map<string, ModuleRec>();
  private readonly routers: RouterObj[] = [];
  private readonly edges = new Map<number, Set<number>>();
  private edgeCount = 0;
  private readonly sinks: DataAccessCall[] = [];
  private readonly sinkKeys = new Set<string>();
  private readonly leaks: Leak[] = [];
  private readonly leakKeys = new Set<string>();
  private readonly limitsHit = new Set<LimitHit>();
  private readonly incompleteFiles = new Map<
    string,
    Set<'interpreter-aborted' | 'stack-overflow'>
  >();
  private readonly requiredBy = new Map<string, Set<string>>();
  private readonly memo = new Map<string, Value[]>();
  private readonly execs = new Map<number, number>();
  private readonly executed = new Set<number>();
  private readonly active = new Map<number, number>();
  private readonly created: FnValue[] = [];
  private readonly ran = new Set<number>();
  private readonly handoffs: [number, number][] = [];
  private readonly queue: FnValue[] = [];
  private readonly scheduled = new Set<number>();
  private readonly moduleObjs = new Set<ObjValue>();
  private orphan: RouterObj | undefined;
  private currentFile = '';

  constructor(
    private readonly files: ReadonlyMap<string, FileFacts>,
    private readonly limits: MapLimits,
    private readonly deadline: number,
  ) {}

  run(): InterpOutput {
    const order = [...this.files.keys()].sort();
    const req = this.staticRequirers();
    const roots = order.filter((f) => !req.has(f));
    const rest = order.filter((f) => req.has(f));
    try {
      for (const f of [...roots, ...rest]) {
        this.runRoot(f);
        this.drain();
      }
      this.sweep();
    } catch (e) {
      if (e instanceof Abort) {
        this.limitsHit.add(e.limit);
        for (const f of this.files.keys()) {
          if (!this.modules.has(f) || this.modules.get(f)?.state === 'running') {
            this.markIncomplete(f, 'interpreter-aborted');
          }
        }
      } else {
        throw e;
      }
    }
    return {
      routers: this.routers,
      edges: this.edges,
      edgeCount: this.edgeCount,
      sinks: this.sinks,
      leaks: this.leaks,
      limitsHit: this.limitsHit,
      incompleteFiles: this.incompleteFiles,
      requiredBy: this.requiredBy,
      executed: this.executed,
      handoffs: this.handoffs,
    };
  }

  // ---- bookkeeping ---------------------------------------------------------------------

  private staticRequirers(): Map<string, Set<string>> {
    for (const [file, facts] of this.files) {
      for (const s of facts.specs) {
        const target = this.resolveSpec(file, s.spec);
        if (target && target !== file) {
          let set = this.requiredBy.get(target);
          if (!set) this.requiredBy.set(target, (set = new Set()));
          set.add(file);
        }
      }
    }
    return this.requiredBy;
  }

  private markIncomplete(file: string, why: 'interpreter-aborted' | 'stack-overflow'): void {
    let s = this.incompleteFiles.get(file);
    if (!s) this.incompleteFiles.set(file, (s = new Set()));
    s.add(why);
  }

  private step(): void {
    if (++this.steps > this.limits.maxSteps) throw new Abort('steps');
    if ((this.steps & 1023) === 0 && Date.now() > this.deadline) throw new Abort('time');
  }

  private addEdge(from: number, to: number): void {
    let s = this.edges.get(from);
    if (!s) this.edges.set(from, (s = new Set()));
    if (!s.has(to)) {
      s.add(to);
      this.edgeCount++;
    }
  }

  private leak(kind: Leak['kind'], file: string, line: number): void {
    const key = `${kind}|${file}|${line}`;
    if (this.leakKeys.has(key)) return;
    this.leakKeys.add(key);
    this.leaks.push({ kind, file, line });
  }

  private sink(
    fr: Frame,
    n: AstNode,
    kind: DataAccessCall['kind'],
    method: string,
    basis: 'value' | 'name',
    collection?: string,
  ): void {
    const key = `${kind}|${fr.facts.path}|${n.r}|${n.er}|${method}`;
    if (this.sinkKeys.has(key)) return;
    this.sinkKeys.add(key);
    const call: DataAccessCall = {
      kind,
      method: safeIdent(method),
      file: fr.facts.path,
      startLine: n.r,
      endLine: n.er,
      fn: fnRef(fr.fn),
      basis,
    };
    if (collection !== undefined)
      call.collection = collection.slice(0, 80).replace(/[^\w$.-]/g, '_');
    this.sinks.push(call);
  }

  private newRouter(fr: Frame, n: AstNode, kind: 'app' | 'router'): RouterValue {
    const r: RouterObj = {
      id: this.routers.length,
      kind,
      file: fr.facts.path,
      line: lineOf(n),
      events: [],
    };
    this.routers.push(r);
    return { k: 'router', id: r.id };
  }

  private orphanRouter(fr: Frame, n: AstNode): RouterObj {
    if (!this.orphan) {
      this.orphan = {
        id: this.routers.length,
        kind: 'orphan',
        file: fr.facts.path,
        line: lineOf(n),
        events: [],
      };
      this.routers.push(this.orphan);
    }
    return this.orphan;
  }

  private newObj(): ObjValue {
    return { k: 'obj', id: this.nextValueId++, props: new Map() };
  }

  // ---- module loading ------------------------------------------------------------------

  /** Resolves a relative specifier to an analyzed file, staying inside the workspace. */
  resolveSpec(from: string, spec: string): string | undefined {
    if (!spec.startsWith('./') && !spec.startsWith('../') && spec !== '.' && spec !== '..') {
      return undefined;
    }
    const base = posix.normalize(posix.join(posix.dirname(from), spec));
    if (base.startsWith('..') || base.startsWith('/')) return undefined;
    for (const ext of MODULE_EXT) {
      const p = `${base}${ext}`;
      if (this.files.has(p)) return p;
    }
    for (const ext of MODULE_EXT.slice(1)) {
      const p = `${base}/index${ext}`;
      if (this.files.has(p)) return p;
    }
    // TypeScript imports name the compiled file (`./x.js` for `./x.ts`).
    const m = /^(.*)\.(?:js|jsx|mjs|cjs)$/.exec(base);
    if (m?.[1]) {
      for (const ext of ['.ts', '.tsx', '.mts', '.cts']) {
        const p = `${m[1]}${ext}`;
        if (this.files.has(p)) return p;
      }
    }
    return undefined;
  }

  private loadModule(file: string): ModuleRec | undefined {
    const existing = this.modules.get(file);
    if (existing) return existing;
    const facts = this.files.get(file);
    const fn = facts?.fns[0];
    if (!facts || !fn) return undefined;
    const exportsObj = this.newObj();
    const moduleObj = this.newObj();
    moduleObj.props.set('exports', [exportsObj]);
    this.moduleObjs.add(moduleObj);
    const rec: ModuleRec = { file, moduleObj, exportsObj, fn, state: 'running' };
    this.modules.set(file, rec);
    const scope = new Scope(null);
    scope.declare('module', [moduleObj]);
    scope.declare('exports', [exportsObj]);
    const fr: Frame = {
      facts,
      fn,
      scope,
      thisVals: [exportsObj],
      returns: [],
      mod: rec,
      depth: 0,
    };
    this.executed.add(fn.id);
    const prev = this.currentFile;
    this.currentFile = file;
    try {
      this.execList(fr, facts.root.c);
    } finally {
      this.currentFile = prev;
      rec.state = 'done';
    }
    return rec;
  }

  private runRoot(file: string): void {
    if (this.modules.has(file)) return;
    try {
      this.loadModule(file);
    } catch (e) {
      if (e instanceof RangeError) this.markIncomplete(this.currentFile || file, 'stack-overflow');
      else throw e;
    }
  }

  private exportsOf(rec: ModuleRec): Value[] {
    return rec.moduleObj.props.get('exports') ?? [];
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const c = this.queue.shift();
      if (!c) break;
      try {
        this.callClosure(1, c, [], []);
      } catch (e) {
        if (e instanceof RangeError) this.markIncomplete(c.fn.file, 'stack-overflow');
        else throw e;
      }
    }
  }

  /**
   * Functions that exist but were never entered (exported helpers nothing here calls, plugin
   * entry points a framework would call) are run once with untracked parameters, so their calls,
   * data access and route registrations are seen. Repeats until nothing new was created.
   */
  private sweep(): void {
    for (let guard = 0; ; guard++) {
      const todo = this.created.filter((c) => !this.ran.has(c.id) && c.fn.kind !== 'class');
      if (todo.length === 0) return;
      if (guard >= 64) {
        this.limitsHit.add('sweep');
        return;
      }
      for (const c of todo) {
        this.ran.add(c.id);
        try {
          this.callClosure(1, c, [], []);
        } catch (err) {
          if (err instanceof RangeError) this.markIncomplete(c.fn.file, 'stack-overflow');
          else throw err;
        }
      }
      this.drain();
    }
  }

  private schedule(c: FnValue): void {
    if (this.scheduled.has(c.id)) return;
    this.scheduled.add(c.id);
    this.queue.push(c);
  }

  // ---- calls ---------------------------------------------------------------------------

  private callClosure(depth: number, c: FnValue, args: Value[][], thisVals: Value[]): Value[] {
    if (c.fn.kind === 'class') return [];
    const facts = this.files.get(c.fn.file);
    if (!facts) return [];
    if (depth > this.limits.maxCallDepth) {
      this.limitsHit.add('call-depth');
      return [];
    }
    const key = `${c.id}|${args.map((a) => sig(a)).join(';')}|${sig(thisVals)}`;
    const cached = this.memo.get(key);
    if (cached) return cached;
    // A function that is already running twice up the stack adds nothing by running again
    // (`new X()` inside X's own constructor builds a fresh instance every time, so the memo
    // key never repeats).
    if ((this.active.get(c.fn.id) ?? 0) >= 2) return [];
    const n = (this.execs.get(c.fn.id) ?? 0) + 1;
    if (n > this.limits.maxExecutionsPerFunction) {
      this.limitsHit.add('executions-per-function');
      return [];
    }
    this.execs.set(c.fn.id, n);
    this.executed.add(c.fn.id);
    this.ran.add(c.id);
    this.memo.set(key, []);
    const mod = this.modules.get(c.fn.file);
    if (!mod) return [];
    this.active.set(c.fn.id, (this.active.get(c.fn.id) ?? 0) + 1);
    const fr: Frame = {
      facts,
      fn: c.fn,
      scope: new Scope(c.scope),
      thisVals: c.lexThis ?? thisVals,
      returns: [],
      mod,
      depth,
    };
    const body = c.fn.node.f['body'];
    try {
      const params = c.fn.node.f['parameters'];
      if (params) {
        params.c.forEach((p, i) => this.bind(fr, p, args[i] ?? [], true));
      } else {
        const single = c.fn.node.f['parameter'];
        if (single) this.bind(fr, single, args[0] ?? [], true);
      }
      if (body) {
        if (body.t === 'statement_block') this.execList(fr, body.c);
        else fr.returns = union(fr.returns, this.ev(fr, body));
      }
    } finally {
      this.active.set(c.fn.id, (this.active.get(c.fn.id) ?? 1) - 1);
    }
    this.capCheck();
    this.memo.set(key, fr.returns);
    return fr.returns;
  }

  private capCheck(): void {
    if (capHit.hit) {
      capHit.hit = false;
      this.limitsHit.add('value-set-cap');
    }
  }

  private construct(fr: Frame, cls: FnValue, inst: ObjValue, args: Value[][]): void {
    const depth = fr.depth + 1;
    const chain: FnValue[] = [];
    for (
      let cur: FnValue | undefined = cls;
      cur && chain.length < 16;
      cur = cur.parentClass?.find((v): v is FnValue => v.k === 'fn')
    ) {
      chain.push(cur);
    }
    // Methods first, base class to derived, so a derived method replaces the base one.
    for (const c of [...chain].reverse()) {
      for (const [k, v] of c.protoProps) inst.props.set(k, v);
    }
    const first = chain.find((c) => c.ctor);
    if (first?.ctor) {
      this.addEdge(fr.fn.id, first.ctor.fn.id);
      const prev = this.ctorStack;
      this.ctorStack = first;
      try {
        this.callClosure(depth, first.ctor, args, [inst]);
      } finally {
        this.ctorStack = prev;
      }
    }
    for (const c of [...chain].reverse()) this.initFields(fr, c, inst);
  }

  private ctorStack: FnValue | undefined;
  private decoratedExport = false;

  private initFields(fr: Frame, cls: FnValue, inst: ObjValue): void {
    if (!cls.fields) return;
    const facts = this.files.get(cls.fn.file);
    const mod = this.modules.get(cls.fn.file);
    if (!facts || !mod) return;
    const ffr: Frame = {
      facts,
      fn: cls.fn,
      scope: new Scope(cls.scope),
      thisVals: [inst],
      returns: [],
      mod,
      depth: fr.depth + 1,
    };
    for (const f of cls.fields) {
      if (f.isStatic) continue;
      inst.props.set(f.name, union(inst.props.get(f.name) ?? [], this.ev(ffr, f.value)));
    }
  }

  // ---- statements ----------------------------------------------------------------------

  private execList(fr: Frame, stmts: readonly AstNode[]): void {
    for (const s of stmts) {
      const d = s.t === 'export_statement' && s.f['declaration'] ? s.f['declaration'] : s;
      if (d && (d.t === 'function_declaration' || d.t === 'generator_function_declaration')) {
        const name = d.f['name']?.x;
        const c = this.closureOf(fr, d);
        if (name && c) fr.scope.declare(name, [c]);
      }
    }
    for (const s of stmts) this.ev(fr, s);
  }

  private closureOf(fr: Frame, n: AstNode): FnValue | undefined {
    const fn = fr.facts.fnByNode.get(n);
    if (!fn) return undefined;
    const c: FnValue = {
      k: 'fn',
      id: this.nextValueId++,
      fn,
      scope: fr.scope,
      lexThis: n.t === 'arrow_function' ? fr.thisVals : undefined,
      protoProps: new Map(),
      staticProps: new Map(),
    };
    this.created.push(c);
    return c;
  }

  private classOf(fr: Frame, n: AstNode): FnValue | undefined {
    const fn = fr.facts.fnByNode.get(n);
    if (!fn) return undefined;
    const scope = new Scope(fr.scope);
    const cls: FnValue = {
      k: 'fn',
      id: this.nextValueId++,
      fn,
      scope,
      protoProps: new Map(),
      staticProps: new Map(),
      fields: [],
    };
    const name = n.f['name']?.x;
    if (name) scope.declare(name, [cls]);
    const heritage = n.c.find((c) => c.t === 'class_heritage');
    const base = heritage?.c[0];
    if (base) cls.parentClass = this.ev(fr, base);
    const body = n.f['body'];
    const decorated = this.decoratedExport || n.c.some((d) => d.t === 'decorator');
    this.decoratedExport = false;
    const cfr: Frame = { ...fr, scope, thisVals: [cls] };
    for (const m of body?.c ?? []) {
      if (m.t === 'method_definition') {
        const mname = keyName(m.f['name']);
        const mc = this.closureOf(cfr, m);
        if (!mname || !mc) continue;
        // Decorated classes and methods (NestJS, TypeORM, ...) are called by a framework.
        if (decorated || m.c.some((d) => d.t === 'decorator')) {
          this.handoffs.push([fr.fn.id, mc.fn.id]);
          this.schedule(mc);
        }
        if (mname === 'constructor') cls.ctor = mc;
        else if (m.op === 'static') cls.staticProps.set(mname, [mc]);
        else cls.protoProps.set(mname, union(cls.protoProps.get(mname) ?? [], [mc]));
      } else if (m.t === 'field_definition') {
        const fname = keyName(m.f['property']);
        const value = m.f['value'];
        if (!fname || !value) continue;
        const member: ClassMember = { name: fname, value, isStatic: m.op === 'static' };
        if (member.isStatic) cls.staticProps.set(fname, this.ev(cfr, value));
        else cls.fields?.push(member);
      }
    }
    return cls;
  }

  // ---- expressions and statements ------------------------------------------------------

  ev(fr: Frame, n: AstNode): Value[] {
    this.step();
    switch (n.t) {
      case 'identifier':
        return n.x === undefined || n.x === 'undefined' ? [] : (fr.scope.get(n.x) ?? []);
      case 'this':
        return fr.thisVals;
      case 'string':
        return [{ k: 'str', v: plainString(n) ?? '', dyn: false }];
      case 'template_string':
        return [this.template(fr, n)];
      case 'parenthesized_expression':
      case 'await_expression':
      case 'as_expression':
      case 'satisfies_expression':
      case 'non_null_expression':
      case 'yield_expression':
      case 'spread_element':
      case 'expression_statement':
        return n.c[0] ? this.ev(fr, n.c[0]) : [];
      case 'type_assertion':
        return n.c[n.c.length - 1] ? this.ev(fr, n.c[n.c.length - 1] as AstNode) : [];
      case 'array':
        return [this.array(fr, n)];
      case 'object':
        return [this.objectLiteral(fr, n)];
      case 'function_expression':
      case 'function':
      case 'generator_function':
      case 'arrow_function': {
        const c = this.closureOf(fr, n);
        return c ? [c] : [];
      }
      case 'class': {
        const c = this.classOf(fr, n);
        return c ? [c] : [];
      }
      case 'member_expression':
        return this.member(fr, n);
      case 'subscript_expression':
        return this.subscript(fr, n);
      case 'call_expression':
        return this.call(fr, n);
      case 'new_expression':
        return this.newExpr(fr, n);
      case 'assignment_expression':
        return this.assignment(fr, n);
      case 'ternary_expression': {
        const [cond, a, b] = n.c;
        if (cond) this.ev(fr, cond);
        return this.either(a ? this.ev(fr, a) : [], b ? this.ev(fr, b) : []);
      }
      case 'binary_expression':
        return this.binary(fr, n);
      case 'sequence_expression': {
        let last: Value[] = [];
        for (const c of n.c) last = this.ev(fr, c);
        return last;
      }
      // statements
      case 'program':
        this.execList(fr, n.c);
        return [];
      case 'statement_block':
        return this.block(fr, n);
      case 'lexical_declaration':
      case 'variable_declaration':
        for (const d of n.c) if (d.t === 'variable_declarator') this.declarator(fr, d);
        return [];
      case 'return_statement':
        if (n.c[0]) fr.returns = union(fr.returns, this.ev(fr, n.c[0]));
        return [];
      case 'if_statement':
        return this.ifStatement(fr, n);
      case 'for_in_statement':
        return this.forIn(fr, n);
      case 'try_statement':
        return this.tryStatement(fr, n);
      case 'switch_statement':
        return this.switchStatement(fr, n);
      case 'function_declaration':
      case 'generator_function_declaration':
        return [];
      case 'class_declaration': {
        const c = this.classOf(fr, n);
        const name = n.f['name']?.x;
        if (c && name) fr.scope.declare(name, [c]);
        return [];
      }
      case 'export_statement':
        this.exportStatement(fr, n);
        return [];
      case 'import_statement':
        this.importStatement(fr, n);
        return [];
      // Leaves that carry no value we track.
      case 'number':
      case 'regex':
      case 'true':
      case 'false':
      case 'null':
      case 'property_identifier':
      case 'statement_identifier':
      case 'break_statement':
      case 'continue_statement':
      case 'empty_statement':
      case 'debugger_statement':
        return [];
      default:
        // Anything else (loops, labels, throw, JSX, TypeScript declarations): walk the
        // children so calls and function literals inside are still seen.
        return this.walkChildren(fr, n);
    }
  }

  private walkChildren(fr: Frame, n: AstNode): Value[] {
    for (const c of n.c) this.ev(fr, c);
    return [];
  }

  private block(fr: Frame, n: AstNode): Value[] {
    const saved = fr.scope;
    fr.scope = new Scope(saved);
    try {
      this.execList(fr, n.c);
    } finally {
      fr.scope = saved;
    }
    return [];
  }

  private ifStatement(fr: Frame, n: AstNode): Value[] {
    const cond = n.f['condition'];
    if (cond) this.ev(fr, cond);
    const a = n.f['consequence'];
    if (a) this.ev(fr, a);
    const b = n.f['alternative'];
    if (b) for (const c of b.t === 'else_clause' ? b.c : [b]) this.ev(fr, c);
    return [];
  }

  private tryStatement(fr: Frame, n: AstNode): Value[] {
    const body = n.f['body'];
    if (body) this.ev(fr, body);
    const handler = n.f['handler'];
    if (handler) {
      const saved = fr.scope;
      fr.scope = new Scope(saved);
      try {
        const param = handler.f['parameter'];
        if (param?.t === 'identifier' && param.x) fr.scope.declare(param.x, []);
        const hb = handler.f['body'];
        if (hb) this.ev(fr, hb);
      } finally {
        fr.scope = saved;
      }
    }
    const fin = n.f['finalizer'];
    if (fin) for (const c of fin.c) this.ev(fr, c);
    return [];
  }

  private switchStatement(fr: Frame, n: AstNode): Value[] {
    const v = n.f['value'];
    if (v) this.ev(fr, v);
    for (const c of n.f['body']?.c ?? []) {
      for (const s of c.c) this.ev(fr, s);
    }
    return [];
  }

  private forIn(fr: Frame, n: AstNode): Value[] {
    const left = n.f['left'];
    const right = n.f['right'];
    const body = n.f['body'];
    const saved = fr.scope;
    fr.scope = new Scope(saved);
    try {
      const rv = right ? this.ev(fr, right) : [];
      const arr = n.op === 'of' ? rv.find((v): v is ArrValue => v.k === 'arr') : undefined;
      const items = arr && arr.items.length <= 64 ? arr.items : undefined;
      const target = left?.t === 'identifier' ? left : left?.c[0];
      if (items && items.length > 0) {
        // `for (const x of [literal strings])`: one pass per element, so a route registered
        // inside the loop gets its real path.
        for (const item of items) {
          fr.scope = new Scope(saved);
          if (target) this.bind(fr, target, item, true);
          if (body) this.ev(fr, body);
        }
      } else {
        if (target) this.bind(fr, target, [], true);
        if (body) this.ev(fr, body);
      }
    } finally {
      fr.scope = saved;
    }
    return [];
  }

  // ---- values --------------------------------------------------------------------------

  private template(fr: Frame, n: AstNode): Value {
    let v = '';
    let dyn = false;
    for (const c of n.c) {
      if (c.t === 'string_fragment') v += c.x ?? '';
      else if (c.t === 'escape_sequence') v += (c.x ?? '').replace(/^\\/, '');
      else if (c.t === 'template_substitution') {
        const inner = c.c[0];
        const vals = inner ? this.ev(fr, inner) : [];
        const only = vals.length === 1 ? vals[0] : undefined;
        if (only?.k === 'str') {
          v += only.v;
          dyn ||= only.dyn;
        } else {
          v += `\${${labelOf(inner)}}`;
          dyn = true;
        }
      }
    }
    return { k: 'str', v: v.slice(0, 512), dyn };
  }

  private array(fr: Frame, n: AstNode): Value {
    const items: Value[][] = [];
    for (const c of n.c) {
      if (c.t === 'spread_element') {
        const inner = c.c[0] ? this.ev(fr, c.c[0]) : [];
        const arr = inner.find((v): v is ArrValue => v.k === 'arr');
        if (arr) items.push(...arr.items);
        else items.push([]);
      } else {
        items.push(this.ev(fr, c));
      }
    }
    if (items.length > 256) {
      // Everything was evaluated; only what is kept is cut, and the cut is reported.
      this.limitsHit.add('value-set-cap');
      items.length = 256;
    }
    return { k: 'arr', items };
  }

  private objectLiteral(fr: Frame, n: AstNode): Value {
    const obj = this.newObj();
    for (const c of n.c) {
      if (c.t === 'pair') {
        const k = c.f['key'];
        const name = k?.t === 'computed_property_name' ? this.constString(fr, k.c[0]) : keyName(k);
        const val = c.f['value'];
        const vals = val ? this.ev(fr, val) : [];
        if (name !== undefined) obj.props.set(name, vals);
      } else if (c.t === 'shorthand_property_identifier' && c.x) {
        obj.props.set(c.x, fr.scope.get(c.x) ?? []);
      } else if (c.t === 'method_definition') {
        const name = keyName(c.f['name']);
        const cl = this.closureOf(fr, c);
        if (name && cl) obj.props.set(name, [cl]);
      } else if (c.t === 'spread_element') {
        const inner = c.c[0] ? this.ev(fr, c.c[0]) : [];
        for (const v of inner) {
          if (v.k === 'obj') for (const [k, p] of v.props) obj.props.set(k, p);
        }
      }
    }
    return obj;
  }

  private constString(fr: Frame, n: AstNode | undefined): string | undefined {
    if (!n) return undefined;
    const vals = this.ev(fr, n);
    const only = vals.length === 1 ? vals[0] : undefined;
    return only?.k === 'str' && !only.dyn ? only.v : undefined;
  }

  private binary(fr: Frame, n: AstNode): Value[] {
    const [l, r] = n.c;
    const lv = l ? this.ev(fr, l) : [];
    const rv = r ? this.ev(fr, r) : [];
    switch (n.op) {
      case '||':
      case '&&':
      case '??':
        return this.either(lv, rv);
      case '+': {
        const a = lv.length === 1 ? lv[0] : undefined;
        const b = rv.length === 1 ? rv[0] : undefined;
        if (a?.k === 'str' || b?.k === 'str') {
          const part = (
            v: Value | undefined,
            node: AstNode | undefined,
          ): { s: string; dyn: boolean } =>
            v?.k === 'str' ? { s: v.v, dyn: v.dyn } : { s: `\${${labelOf(node)}}`, dyn: true };
          const x = part(a, l);
          const y = part(b, r);
          return [{ k: 'str', v: (x.s + y.s).slice(0, 512), dyn: x.dyn || y.dyn }];
        }
        return [];
      }
      default:
        return [];
    }
  }

  /**
   * Either of two value sets. When one side is untracked, the strings on the other side are
   * only one of the possible values, so they are marked as not fully known.
   */
  private either(a: Value[], b: Value[]): Value[] {
    const weak = (vs: Value[]): Value[] =>
      vs.map((v) => (v.k === 'str' && !v.dyn ? { ...v, dyn: true } : v));
    if (a.length === 0) return weak(b);
    if (b.length === 0) return weak(a);
    return union(a, b);
  }

  private getProp(v: Value, name: string): Value[] {
    switch (v.k) {
      case 'obj':
        return v.props.get(name) ?? [];
      case 'fn':
        if (name === 'prototype') return [{ k: 'obj', id: -v.id, props: v.protoProps }];
        return v.staticProps.get(name) ?? [];
      case 'ext':
        return [{ k: 'ext', pkg: v.pkg, path: [...v.path, name].slice(0, 12) }];
      case 'arr': {
        const i = /^\d+$/.test(name) ? Number(name) : -1;
        return v.items[i] ?? [];
      }
      default:
        return [];
    }
  }

  private member(fr: Frame, n: AstNode): Value[] {
    const obj = n.f['object'];
    const prop = n.f['property']?.x;
    if (!obj) return [];
    const ov = this.ev(fr, obj);
    if (prop === undefined) return [];
    let out: Value[] = [];
    for (const v of ov) out = union(out, this.getProp(v, prop));
    return out;
  }

  private subscript(fr: Frame, n: AstNode): Value[] {
    const obj = n.f['object'];
    const idx = n.f['index'];
    if (!obj) return [];
    const ov = this.ev(fr, obj);
    if (!idx) return [];
    const key =
      idx.t === 'number'
        ? idx.x
        : idx.t === 'string'
          ? plainString(idx)
          : this.constString(fr, idx);
    if (key === undefined) return [];
    let out: Value[] = [];
    for (const v of ov) out = union(out, this.getProp(v, key));
    return out;
  }

  // ---- declarations and assignment -----------------------------------------------------

  private declarator(fr: Frame, d: AstNode): void {
    const name = d.f['name'];
    const value = d.f['value'];
    const vals = value ? this.ev(fr, value) : [];
    if (name) this.bind(fr, name, vals, true);
  }

  /** Binds a pattern (identifier, destructuring, parameter) to a value set. */
  private bind(fr: Frame, p: AstNode, vals: Value[], declare: boolean): void {
    switch (p.t) {
      case 'identifier':
        if (p.x) {
          if (declare) fr.scope.declare(p.x, vals);
          else fr.scope.assign(p.x, vals);
        }
        return;
      case 'required_parameter':
      case 'optional_parameter': {
        const pat = p.f['pattern'];
        if (pat) this.bind(fr, pat, vals, declare);
        return;
      }
      case 'assignment_pattern': {
        const l = p.f['left'];
        const r = p.f['right'];
        const dflt = r ? this.ev(fr, r) : [];
        if (l) this.bind(fr, l, union(vals, dflt), declare);
        return;
      }
      case 'rest_pattern':
        if (p.c[0]) this.bind(fr, p.c[0], [], declare);
        return;
      case 'object_pattern':
        for (const c of p.c) {
          if (c.t === 'shorthand_property_identifier_pattern' && c.x) {
            this.bind(fr, { ...c, t: 'identifier' }, this.propsOf(vals, c.x), declare);
          } else if (c.t === 'object_assignment_pattern') {
            const l = c.f['left'];
            const r = c.f['right'];
            const dflt = r ? this.ev(fr, r) : [];
            if (l?.x) {
              this.bind(
                fr,
                { ...l, t: 'identifier' },
                union(this.propsOf(vals, l.x), dflt),
                declare,
              );
            }
          } else if (c.t === 'pair_pattern') {
            const key = keyName(c.f['key']);
            const val = c.f['value'];
            if (val) this.bind(fr, val, key === undefined ? [] : this.propsOf(vals, key), declare);
          } else if (c.t === 'rest_pattern' && c.c[0]) {
            this.bind(fr, c.c[0], [], declare);
          }
        }
        return;
      case 'array_pattern':
        p.c.forEach((c, i) => {
          this.bind(fr, c, this.propsOf(vals, String(i)), declare);
        });
        return;
      case 'member_expression':
      case 'subscript_expression':
        this.assignTo(fr, p, vals);
        return;
      default:
        return;
    }
  }

  private propsOf(vals: Value[], name: string): Value[] {
    let out: Value[] = [];
    for (const v of vals) out = union(out, this.getProp(v, name));
    return out;
  }

  private assignment(fr: Frame, n: AstNode): Value[] {
    const left = n.f['left'];
    const right = n.f['right'];
    const vals = right ? this.ev(fr, right) : [];
    if (!left) return vals;
    if (n.op && n.op !== '=') return vals; // `+=`, `||=` and the like
    if (left.t === 'identifier') {
      if (left.x) fr.scope.assign(left.x, vals);
    } else if (left.t === 'member_expression' || left.t === 'subscript_expression') {
      this.assignTo(fr, left, vals);
    } else {
      this.bind(fr, left, vals, false);
    }
    return vals;
  }

  private assignTo(fr: Frame, target: AstNode, vals: Value[]): void {
    const objNode = target.f['object'];
    if (!objNode) return;
    const name =
      target.t === 'member_expression'
        ? target.f['property']?.x
        : this.constString(fr, target.f['index']);
    if (name === undefined) return;
    const holders = this.ev(fr, objNode);
    for (const h of holders) {
      if (h.k === 'obj') {
        // `module.exports = x` replaces; every other property write is a weak update.
        const isModuleObj = this.moduleObjs.has(h);
        h.props.set(name, isModuleObj ? vals : union(h.props.get(name) ?? [], vals));
      } else if (h.k === 'fn') {
        h.staticProps.set(name, union(h.staticProps.get(name) ?? [], vals));
      }
    }
  }

  // ---- imports and exports -------------------------------------------------------------

  private importStatement(fr: Frame, n: AstNode): void {
    const src = plainString(n.f['source']);
    if (src === undefined) return;
    const mod = this.requireSpec(fr, src);
    const clause = n.c.find((c) => c.t === 'import_clause');
    if (!clause) return;
    for (const c of clause.c) {
      if (c.t === 'identifier' && c.x) {
        // A package's default import is the package itself (CommonJS interop); a repo module's
        // is its `default` export, or the whole exports object when it has none.
        const def = mod.some((v) => v.k === 'ext') ? [] : this.propsOf(mod, 'default');
        fr.scope.declare(c.x, def.length > 0 ? def : mod);
      } else if (c.t === 'namespace_import') {
        const id = c.c[0];
        if (id?.x) fr.scope.declare(id.x, mod);
      } else if (c.t === 'named_imports') {
        for (const s of c.c) {
          if (s.t !== 'import_specifier') continue;
          const nm = s.f['name']?.x;
          const alias = s.f['alias']?.x ?? nm;
          if (nm && alias) fr.scope.declare(alias, this.propsOf(mod, nm));
        }
      }
    }
  }

  private exportStatement(fr: Frame, n: AstNode): void {
    const exportsObj = fr.mod.exportsObj;
    const put = (name: string, vals: Value[]): void => {
      exportsObj.props.set(name, union(exportsObj.props.get(name) ?? [], vals));
    };
    const decl = n.f['declaration'];
    const value = n.f['value'];
    const src = plainString(n.f['source']);
    if (decl) {
      this.decoratedExport = n.c.some((d) => d.t === 'decorator');
      this.ev(fr, decl);
      this.decoratedExport = false;
      if (decl.t === 'lexical_declaration' || decl.t === 'variable_declaration') {
        for (const d of decl.c) {
          const nm = d.f['name'];
          if (nm?.t === 'identifier' && nm.x) put(nm.x, fr.scope.get(nm.x) ?? []);
        }
      } else {
        const nm = decl.f['name']?.x;
        if (nm) put(nm, fr.scope.get(nm) ?? []);
      }
      if (n.op === 'default') {
        const nm = decl.f['name']?.x;
        if (nm) put('default', fr.scope.get(nm) ?? []);
      }
      return;
    }
    if (value) {
      put('default', this.ev(fr, value));
      return;
    }
    const mod = src === undefined ? undefined : this.requireSpec(fr, src);
    const clause = n.c.find((c) => c.t === 'export_clause');
    if (clause) {
      for (const s of clause.c) {
        if (s.t !== 'export_specifier') continue;
        const nm = s.f['name']?.x;
        const alias = s.f['alias']?.x ?? nm;
        if (!nm || !alias) continue;
        put(alias, mod ? this.propsOf(mod, nm) : (fr.scope.get(nm) ?? []));
      }
    } else if (mod) {
      // `export * from 'x'`
      for (const v of mod) if (v.k === 'obj') for (const [k, p] of v.props) put(k, p);
    }
  }

  private requireSpec(fr: Frame, spec: string): Value[] {
    const target = this.resolveSpec(fr.facts.path, spec);
    if (target) {
      const rec = this.loadModule(target);
      if (!rec) return [];
      this.addEdge(fr.fn.id, rec.fn.id);
      return this.exportsOf(rec);
    }
    if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) {
      // A local specifier that is not an analyzed source file (JSON, a missing file).
      return [];
    }
    const pkg = spec.replace(/^node:/, '');
    return [{ k: 'ext', pkg, path: [] }];
  }

  // ---- calls ---------------------------------------------------------------------------

  private argValues(fr: Frame, args: AstNode | undefined): { nodes: AstNode[]; vals: Value[][] } {
    const nodes: AstNode[] = [];
    const vals: Value[][] = [];
    for (const a of args?.c ?? []) {
      if (a.t === 'spread_element') {
        const inner = a.c[0] ? this.ev(fr, a.c[0]) : [];
        const arr = inner.find((v): v is ArrValue => v.k === 'arr');
        if (arr) {
          for (const item of arr.items) {
            nodes.push(a);
            vals.push(item);
          }
        } else {
          nodes.push(a);
          vals.push([]);
        }
      } else {
        nodes.push(a);
        vals.push(this.ev(fr, a));
      }
    }
    return { nodes, vals };
  }

  private call(fr: Frame, n: AstNode): Value[] {
    const fnNode = n.f['function'];
    const argsNode = n.f['arguments'];
    if (!fnNode) return [];
    const line = lineOf(n);

    if (fnNode.t === 'identifier' && fnNode.x === 'require' && !fr.scope.get('require')) {
      const a = argsNode?.c[0];
      const lit = a ? plainString(a) : undefined;
      if (a && lit === undefined) {
        const vals = this.ev(fr, a);
        const only = vals.length === 1 ? vals[0] : undefined;
        if (only?.k === 'str' && !only.dyn) return this.requireSpec(fr, only.v);
        this.leak('dynamic-require', fr.facts.path, line);
        return [];
      }
      return lit === undefined ? [] : this.requireSpec(fr, lit);
    }
    if (fnNode.t === 'import') {
      const a = argsNode?.c[0];
      const lit = a ? plainString(a) : undefined;
      if (lit === undefined) {
        this.leak('dynamic-require', fr.facts.path, line);
        return [];
      }
      return this.requireSpec(fr, lit);
    }
    if (fnNode.t === 'identifier' && fnNode.x === 'eval' && !fr.scope.get('eval')) {
      this.argValues(fr, argsNode);
      this.sink(fr, n, 'code-eval', 'eval', 'value');
      if (plainString(argsNode?.c[0]) === undefined) this.leak('code-eval', fr.facts.path, line);
      return [];
    }
    if (fnNode.t === 'super') {
      const { vals } = this.argValues(fr, argsNode);
      const cls = this.ctorStack;
      const parent = cls?.parentClass?.find((v): v is FnValue => v.k === 'fn');
      const inst = fr.thisVals.find((v): v is ObjValue => v.k === 'obj');
      if (parent && inst) this.construct(fr, parent, inst, vals);
      return [];
    }

    // Callee values, and the receiver for member calls.
    let callee: Value[] = [];
    let recv: Value[] = [];
    let method: string | undefined;
    let recvNode: AstNode | undefined;
    if (fnNode.t === 'member_expression') {
      recvNode = fnNode.f['object'];
      method = fnNode.f['property']?.x;
      recv = recvNode ? this.ev(fr, recvNode) : [];
      if (method !== undefined)
        for (const v of recv) callee = union(callee, this.getProp(v, method));
    } else if (fnNode.t === 'subscript_expression') {
      recvNode = fnNode.f['object'];
      recv = recvNode ? this.ev(fr, recvNode) : [];
      const idx = fnNode.f['index'];
      const key = idx
        ? idx.t === 'number'
          ? idx.x
          : idx.t === 'string'
            ? plainString(idx)
            : this.constString(fr, idx)
        : undefined;
      if (key !== undefined) {
        method = key;
        for (const v of recv) callee = union(callee, this.getProp(v, key));
      } else {
        // `obj[expr](...)`: every function the object holds may be the target.
        for (const v of recv) {
          if (v.k === 'obj') for (const p of v.props.values()) callee = union(callee, p);
        }
      }
    } else {
      callee = this.ev(fr, fnNode);
    }

    // Router registration: `app.get(...)`, `router.use(...)`, `app.route(...)`.
    const routers = recv.filter((v): v is RouterValue => v.k === 'router');
    const routeObjs = recv.filter((v): v is RouteValue => v.k === 'route');
    if (method !== undefined && (routers.length > 0 || routeObjs.length > 0)) {
      const { nodes, vals } = this.argValues(fr, argsNode);
      return this.registerRoute(fr, n, routers, routeObjs, method, nodes, vals);
    }

    const { nodes, vals } = this.argValues(fr, argsNode);

    // `app.get.call(app, '/x', fn)` and `.apply`: a registration through the method object.
    if (
      (method === 'call' || method === 'apply') &&
      fnNode.t === 'member_expression' &&
      fnNode.f['object']?.t === 'member_expression'
    ) {
      const inner = fnNode.f['object'];
      const innerMethod = inner.f['property']?.x;
      const innerObj = inner.f['object'];
      const holders = innerObj ? this.ev(fr, innerObj) : [];
      const rs = holders.filter((v): v is RouterValue => v.k === 'router');
      if (innerMethod !== undefined && rs.length > 0) {
        const rest =
          method === 'call'
            ? { nodes: nodes.slice(1), vals: vals.slice(1) }
            : {
                nodes: ((vals[1] ?? []).find((x): x is ArrValue => x.k === 'arr')?.items ?? []).map(
                  () => nodes[1] ?? n,
                ),
                vals: (vals[1] ?? []).find((x): x is ArrValue => x.k === 'arr')?.items ?? [],
              };
        return this.registerRoute(fr, n, rs, [], innerMethod, rest.nodes, rest.vals);
      }
    }
    if (fnNode.t === 'member_expression' && labelOf(fnNode) === 'Reflect.apply') {
      this.leak('unresolved-router', fr.facts.path, line);
    }

    // `.call`, `.apply` and `.bind` on a repo function.
    if (
      (method === 'call' || method === 'apply' || method === 'bind') &&
      recv.some((v) => v.k === 'fn')
    ) {
      let out: Value[] = [];
      for (const v of recv) {
        if (v.k !== 'fn') continue;
        this.addEdge(fr.fn.id, v.fn.id);
        if (method === 'bind') {
          out = union(out, [v]);
        } else {
          const rest =
            method === 'call'
              ? vals.slice(1)
              : ((vals[1] ?? []).find((x): x is ArrValue => x.k === 'arr')?.items ?? []);
          out = union(out, this.callClosure(fr.depth + 1, v, rest, vals[0] ?? []));
        }
      }
      return out;
    }

    // Unresolved receiver that is shaped like a router: record the registration by shape.
    if (
      method !== undefined &&
      recv.length === 0 &&
      recvNode &&
      (VERBS.has(method) || method === 'use') &&
      this.looksLikeRouterCall(recvNode, method, nodes, vals)
    ) {
      this.leak('unresolved-router', fr.facts.path, line);
      const orphan = this.orphanRouter(fr, n);
      return this.registerRoute(fr, n, [{ k: 'router', id: orphan.id }], [], method, nodes, vals);
    }

    // Data access and dangerous calls, when the callee is not repo code.
    const userCallee = callee.some((v) => v.k === 'fn');
    if (method !== undefined && !userCallee) {
      this.dataAccess(fr, n, recv, recvNode, method, nodes);
    }
    if (fnNode.t === 'identifier' && fnNode.x && !userCallee) {
      if (COMMAND_FNS.has(fnNode.x) && callee.some((v) => v.k === 'ext')) {
        this.maybeCommand(fr, n, nodes[0]);
      }
    }

    if (fnNode.t === 'subscript_expression' && method === undefined && callee.length === 0) {
      this.leak('dynamic-dispatch', fr.facts.path, line);
    }

    let result: Value[] = [];
    const thisForCall =
      fnNode.t === 'member_expression' || fnNode.t === 'subscript_expression' ? recv : [];
    for (const v of callee) {
      if (v.k === 'fn') {
        this.addEdge(fr.fn.id, v.fn.id);
        result = union(result, this.callClosure(fr.depth + 1, v, vals, thisForCall));
      } else if (v.k === 'ext') {
        result = union(result, this.extCall(fr, n, v, vals, false));
      }
    }
    if (method === 'collection' && callee.length === 0) {
      const nm = vals[0]?.find((x) => x.k === 'str');
      result = union(result, [{ k: 'coll', name: nm?.k === 'str' ? nm.v : undefined }]);
    }
    // A function passed to any call may be called by it: record the edge and analyze the body.
    // When the callee is not repo code the function is also handed to code the map cannot see.
    const opaque = !userCallee;
    const benign =
      callee.length > 0 && callee.every((v) => v.k === 'ext' && BENIGN_ROUTER_SINKS.has(v.pkg));
    this.handOff(fr, vals, opaque, opaque && !benign, line);
    this.capCheck();
    return result;
  }

  /**
   * Functions among the arguments (also inside objects and arrays, to a bounded depth and count)
   * get a call edge and are analyzed. When the callee is not repo code they are also handed to
   * code the map cannot see, and a router passed to such a callee may get routes the map
   * does not see.
   */
  private handOff(
    fr: Frame,
    vals: Value[][],
    opaque: boolean,
    escapes: boolean,
    line: number,
  ): void {
    let budget = 512;
    const seen = new Set<Value>();
    const visit = (v: Value, depth: number): void => {
      if (seen.has(v)) return;
      seen.add(v);
      if (budget-- <= 0) {
        this.limitsHit.add('value-set-cap');
        return;
      }
      if (v.k === 'fn') {
        this.addEdge(fr.fn.id, v.fn.id);
        if (opaque) this.handoffs.push([fr.fn.id, v.fn.id]);
        this.schedule(v);
        for (const p of v.staticProps.values())
          if (depth < 4) for (const x of p) visit(x, depth + 1);
      } else if (v.k === 'router') {
        if (escapes) this.leak('unresolved-router', fr.facts.path, line);
      } else if (depth < 4) {
        if (v.k === 'obj') for (const p of v.props.values()) for (const x of p) visit(x, depth + 1);
        else if (v.k === 'arr')
          for (const item of v.items) for (const x of item) visit(x, depth + 1);
      }
    };
    for (const a of vals) for (const v of a) visit(v, 0);
  }

  /** `x.get('/p', fn)` or `x.use(fn)` where `x` is named like a router but is not tracked. */
  private looksLikeRouterCall(
    recvNode: AstNode,
    method: string,
    nodes: AstNode[],
    vals: Value[][],
  ): boolean {
    const last = labelOf(recvNode).split('.').pop() ?? '';
    if (!ROUTERISH.test(last)) return false;
    const hasFn = vals.some((a) => a.some((v) => v.k === 'fn'));
    if (method === 'use') return vals.length >= 1 && hasFn;
    const first = nodes[0];
    const path = first ? plainString(first) : undefined;
    return (
      vals.length >= 2 && path !== undefined && (path.startsWith('/') || path === '*') && hasFn
    );
  }

  private dataAccess(
    fr: Frame,
    n: AstNode,
    recv: Value[],
    recvNode: AstNode | undefined,
    method: string,
    nodes: AstNode[],
  ): void {
    const label = labelOf(recvNode);
    const last = label.split('.').pop()?.replace(/\(\)$/, '') ?? '';
    const coll = recv.find((v) => v.k === 'coll');
    const ext = recv.find((v) => v.k === 'ext');
    if (MONGO_METHODS.has(method)) {
      if (coll?.k === 'coll') {
        this.sink(fr, n, 'mongo', method, 'value', coll.name);
        return;
      }
      if (COLL_NAME.test(last) && recv.length === 0) {
        this.sink(fr, n, 'mongo', method, 'name');
        return;
      }
    }
    if (SQL_METHODS.has(method)) {
      const first = nodes[0];
      const stringish =
        first !== undefined &&
        (first.t === 'string' ||
          first.t === 'template_string' ||
          first.t === 'binary_expression' ||
          first.t === 'identifier' ||
          first.t === 'call_expression');
      const viaPkg = ext?.k === 'ext' && SQL_PKGS.has(ext.pkg);
      const viaName = recv.length === 0 && SQL_RECEIVER.test(last);
      const strong =
        method === 'query' || method === 'execute' || method === 'raw' || method === 'exec';
      if ((viaPkg || viaName) && (strong || stringish)) {
        this.sink(fr, n, 'sql', method, viaPkg ? 'value' : 'name');
        return;
      }
    }
    if (COMMAND_FNS.has(method) && ext?.k === 'ext' && ext.pkg === 'child_process') {
      this.maybeCommand(fr, n, nodes[0]);
    }
    if (ext?.k === 'ext' && ext.pkg === 'vm' && /^run/.test(method)) {
      this.sink(fr, n, 'code-eval', method, 'value');
    }
  }

  private maybeCommand(fr: Frame, n: AstNode, first: AstNode | undefined): void {
    const method = labelOf(n.f['function']).split('.').pop() ?? 'exec';
    if (first && first.t !== 'string') this.sink(fr, n, 'command', method, 'value');
  }

  private extCall(fr: Frame, n: AstNode, v: ExtValue, vals: Value[][], isNew: boolean): Value[] {
    if (ROUTER_PKGS.has(v.pkg)) {
      if (v.path.length === 0) return [this.newRouter(fr, n, 'app')];
      if (v.path.length === 1 && v.path[0] === 'Router') return [this.newRouter(fr, n, 'router')];
    }
    if (v.pkg === 'mongoose' && v.path.length === 1 && v.path[0] === 'model') {
      const nm = vals[0]?.find((x) => x.k === 'str');
      return [{ k: 'coll', name: nm?.k === 'str' ? nm.v : undefined }];
    }
    if (v.path.length === 0 && v.pkg === 'Function') {
      this.sink(fr, n, 'code-eval', 'Function', 'value');
      this.leak('code-eval', fr.facts.path, lineOf(n));
      return [];
    }
    return [{ k: 'ext', pkg: v.pkg, path: [...v.path, isNew ? 'new()' : '()'].slice(0, 12) }];
  }

  private newExpr(fr: Frame, n: AstNode): Value[] {
    const ctorNode = n.f['constructor'];
    const { vals } = this.argValues(fr, n.f['arguments']);
    if (!ctorNode) return [];
    if (ctorNode.t === 'identifier' && ctorNode.x === 'Function' && !fr.scope.get('Function')) {
      this.sink(fr, n, 'code-eval', 'Function', 'value');
      this.leak('code-eval', fr.facts.path, lineOf(n));
      return [];
    }
    const ctors = this.ev(fr, ctorNode);
    let out: Value[] = [];
    for (const c of ctors) {
      if (c.k === 'fn') {
        const inst = this.newObj();
        this.addEdge(fr.fn.id, c.fn.id);
        if (c.fn.kind === 'class') {
          this.construct(fr, c, inst, vals);
        } else {
          for (const [k, p] of c.protoProps) inst.props.set(k, p);
          this.callClosure(fr.depth + 1, c, vals, [inst]);
          // Prototype methods assigned after the constructor ran are seen through the shared map.
          for (const [k, p] of c.protoProps) inst.props.set(k, union(inst.props.get(k) ?? [], p));
        }
        out = union(out, [inst]);
      } else if (c.k === 'ext') {
        out = union(out, this.extCall(fr, n, c, vals, true));
      }
    }
    const opaque = !ctors.some((c) => c.k === 'fn');
    this.handOff(fr, vals, opaque, opaque, lineOf(n));
    return out;
  }

  // ---- routes --------------------------------------------------------------------------

  private pathsFrom(fr: Frame, node: AstNode | undefined, vals: Value[]): PathVal[] {
    const out: PathVal[] = [];
    const take = (v: Value): void => {
      if (v.k === 'str') out.push({ text: v.v.slice(0, 200), dynamic: v.dyn });
      else if (v.k === 'arr') for (const item of v.items) for (const x of item) take(x);
    };
    for (const v of vals) take(v);
    if (out.length === 0) {
      out.push({
        text: node?.t === 'regex' ? '<regex>' : `\${${labelOf(node)}}`,
        dynamic: true,
      });
    }
    void fr;
    if (out.length > 16) this.limitsHit.add('value-set-cap');
    return out.slice(0, 16);
  }

  private isPathArg(node: AstNode | undefined, vals: Value[]): boolean {
    if (!node) return false;
    if (node.t === 'regex') return true;
    if (vals.length === 0) return false;
    return vals.every(
      (v) =>
        v.k === 'str' ||
        (v.k === 'arr' && v.items.every((i) => i.length > 0 && i.every((x) => x.k === 'str'))),
    );
  }

  private handlerRefs(fr: Frame, nodes: AstNode[], vals: Value[][], from: number): HandlerRef[] {
    const out: HandlerRef[] = [];
    const push = (node: AstNode | undefined, v: Value[], label?: string): void => {
      const closures = v.filter((x) => x.k === 'fn');
      const ext = v.some((x) => x.k === 'ext');
      const router = v.some((x) => x.k === 'router');
      out.push({
        label: label ?? labelOf(node),
        vals: v,
        file: fr.facts.path,
        line: node ? lineOf(node) : 0,
        unresolved: closures.length === 0 && !ext && !router,
        external: ext && closures.length === 0,
        optional: looksOptional(node),
      });
    };
    for (let i = from; i < nodes.length; i++) {
      const node = nodes[i];
      const v = vals[i] ?? [];
      const arr = v.find((x): x is ArrValue => x.k === 'arr');
      if (node?.t === 'array' && arr) {
        arr.items.forEach((item, j) => push(node.c[j] ?? node, item));
      } else if (arr && v.length === 1) {
        arr.items.forEach((item) => push(node, item, '<array>'));
      } else {
        push(node, v);
      }
    }
    return out;
  }

  private registerRoute(
    fr: Frame,
    n: AstNode,
    routers: RouterValue[],
    routeObjs: RouteValue[],
    method: string,
    nodes: AstNode[],
    vals: Value[][],
  ): Value[] {
    const line = lineOf(n);
    const file = fr.facts.path;
    const track = (handlers: HandlerRef[]): void => {
      for (const h of handlers) {
        if (h.unresolved) this.leak('unresolved-handler', file, h.line || line);
        for (const v of h.vals) if (v.k === 'fn') this.schedule(v);
      }
    };
    // `app.route('/p').get(h)`: the receiver is a route object.
    for (const r of routeObjs) {
      if (!VERBS.has(method)) continue;
      const handlers = this.handlerRefs(fr, nodes, vals, 0);
      track(handlers);
      this.routers[r.router]?.events.push({
        seq: ++this.seq,
        kind: 'route',
        method: method.toUpperCase(),
        paths: r.paths,
        handlers,
        file,
        line,
      });
    }
    if (routers.length === 0) return routeObjs.length > 0 ? routeObjs : [];
    if (method === 'route') {
      return routers.map((r) => ({
        k: 'route' as const,
        router: r.id,
        paths: this.pathsFrom(fr, nodes[0], vals[0] ?? []),
      }));
    }
    if (method === 'use') {
      // An untracked first argument followed by more is a path or a middleware; either way it
      // scopes what follows in a way the map cannot pin down.
      const unresolvedFirst = (vals[0]?.length ?? 0) === 0 && nodes.length > 1;
      if (unresolvedFirst) this.leak('unresolved-handler', file, line);
      const hasPath = unresolvedFirst || this.isPathArg(nodes[0], vals[0] ?? []);
      const paths = hasPath ? this.pathsFrom(fr, nodes[0], vals[0] ?? []) : null;
      const items = this.handlerRefs(fr, nodes, vals, hasPath ? 1 : 0);
      for (const r of routers) {
        const ro = this.routers[r.id];
        if (!ro) continue;
        for (const item of items) {
          const children = item.vals.filter((v): v is RouterValue => v.k === 'router');
          if (children.length > 0) {
            for (const ch of children) {
              ro.events.push({ seq: ++this.seq, kind: 'mount', paths, child: ch.id, file, line });
            }
          } else {
            track([item]);
            ro.events.push({ seq: ++this.seq, kind: 'use', paths, items: [item], file, line });
          }
        }
      }
      return routers;
    }
    if (VERBS.has(method)) {
      // `app.get('name')` with a single string is the settings getter, not a route.
      if (method === 'get' && nodes.length < 2) return [];
      const paths = this.pathsFrom(fr, nodes[0], vals[0] ?? []);
      const handlers = this.handlerRefs(fr, nodes, vals, 1);
      if (handlers.length === 0) return [];
      track(handlers);
      for (const r of routers) {
        this.routers[r.id]?.events.push({
          seq: ++this.seq,
          kind: 'route',
          method: method.toUpperCase(),
          paths,
          handlers,
          file,
          line,
        });
      }
      return routers;
    }
    // `param`, `set`, `listen`, `engine` and the rest do not add routes.
    this.handOff(fr, vals, true, false, line);
    return [];
  }
}
