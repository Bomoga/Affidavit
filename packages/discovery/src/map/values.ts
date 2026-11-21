/**
 * The abstract values the interpreter tracks. A value set (`Value[]`) is what an expression may
 * evaluate to; an empty set means "nothing tracked" (unknown), which is never read as "none".
 */
import { createHash } from 'node:crypto';
import type { AstNode } from './parse.js';
import type { FnInfo } from './prepass.js';

/**
 * Counts writes to anything a memoized call could have read: object, array and function
 * properties, variables that exist already, and module-level declarations. A call is only reused
 * while this has not moved, so a mutation between two identical-looking calls is never missed.
 */
export const mutation = { epoch: 0 };

export class Scope {
  readonly vars = new Map<string, Value[]>();
  constructor(readonly parent: Scope | null) {}

  get(name: string): Value[] | undefined {
    return this.vars.get(name) ?? this.parent?.get(name);
  }

  declare(name: string, vals: Value[]): void {
    if (this.parent === null) mutation.epoch++;
    this.vars.set(name, vals);
  }

  private owner(name: string): Scope | undefined {
    return this.vars.has(name) ? this : this.parent?.owner(name);
  }

  private outermost(): Scope {
    return this.parent ? this.parent.outermost() : this;
  }

  /** Weak update in the scope that declares `name`, else a new binding in the outermost scope. */
  assign(name: string, vals: Value[]): void {
    mutation.epoch++;
    const o = this.owner(name);
    if (o) o.vars.set(name, union(o.vars.get(name) ?? [], vals));
    else this.outermost().vars.set(name, vals);
  }
}

export interface StrValue {
  k: 'str';
  v: string;
  /** True when part of the text came from an expression the map could not reduce. */
  dyn: boolean;
}
export interface ArrValue {
  k: 'arr';
  /** Identity, for memoization. */
  id: number;
  items: Value[][];
}
export interface ObjValue {
  k: 'obj';
  id: number;
  props: Map<string, Value[]>;
}
export interface ClassMember {
  name: string;
  value: AstNode;
  isStatic: boolean;
}
export interface FnValue {
  k: 'fn';
  id: number;
  fn: FnInfo;
  scope: Scope;
  /** `this` captured by an arrow function. */
  lexThis?: Value[];
  protoProps: Map<string, Value[]>;
  staticProps: Map<string, Value[]>;
  /** Class only. */
  parentClass?: Value[];
  ctor?: FnValue;
  fields?: ClassMember[];
}
export interface RouterValue {
  k: 'router';
  id: number;
}
export interface RouteValue {
  k: 'route';
  router: number;
  paths: PathVal[];
}
export interface ExtValue {
  k: 'ext';
  pkg: string;
  path: string[];
}
export interface CollValue {
  k: 'coll';
  name?: string;
}
export type Value =
  StrValue | ArrValue | ObjValue | FnValue | RouterValue | RouteValue | ExtValue | CollValue;

export interface PathVal {
  text: string;
  dynamic: boolean;
}

export const VALUE_SET_CAP = 32;

const same = (a: Value, b: Value): boolean => {
  if (a === b) return true;
  if (a.k !== b.k) return false;
  switch (a.k) {
    case 'str':
      return b.k === 'str' && a.v === b.v && a.dyn === b.dyn;
    case 'ext':
      return b.k === 'ext' && a.pkg === b.pkg && a.path.join('.') === b.path.join('.');
    case 'coll':
      return b.k === 'coll' && a.name === b.name;
    case 'router':
      return b.k === 'router' && a.id === b.id;
    default:
      return false;
  }
};

/** Set union by identity (strings and externals by content). Capped; see `capHit`. */
export function union(a: Value[], b: Value[]): Value[] {
  if (b.length === 0) return a;
  const out = a.slice();
  for (const v of b) if (!out.some((x) => same(x, v))) out.push(v);
  if (out.length > VALUE_SET_CAP) {
    capHit.hit = true;
    return out.slice(0, VALUE_SET_CAP);
  }
  return out;
}

/** Set by `union` when a value set was cut at the cap; the interpreter reads and clears it. */
export const capHit = { hit: false };

const hashOf = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 32);

/**
 * Signature used to memoize calls by argument shape. Lossless: two different values never share
 * one (long strings by length and a 128-bit hash, arrays and objects by identity, everything
 * else in full), and linear in the size of the value set, so it cannot blow up.
 */
export function sig(vals: readonly Value[]): string {
  return vals
    .map((v) => {
      switch (v.k) {
        case 'str':
          return v.v.length <= 48
            ? `s${v.v.length}:${v.v}${v.dyn ? '~' : ''}`
            : `h${v.v.length}:${hashOf(v.v)}${v.dyn ? '~' : ''}`;
        case 'ext':
          return `e${JSON.stringify([v.pkg, v.path])}`;
        case 'arr':
          return `a${v.id}`;
        case 'obj':
          return `o${v.id}`;
        case 'fn':
          return `f${v.id}`;
        case 'router':
          return `r${v.id}`;
        case 'route':
          return `u${v.router}:${v.paths.map((p) => `${p.text.length}:${p.text}`).join(',')}`;
        case 'coll':
          return `c${JSON.stringify(v.name ?? null)}`;
      }
    })
    .join('|');
}
