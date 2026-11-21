/**
 * Static reader for a target's Dockerfile (L2-04, split build). Nothing in the Dockerfile is
 * executed: the split build takes the final stage's base image, working directory, environment,
 * exposed ports and start command from here, and replaces every RUN step with its own sandboxed
 * dependency fetch and offline install (see build.ts).
 */

export interface FinalStage {
  /** Base image reference of the final stage, as written (pinned later by images.ts). */
  base: string;
  workdir: string;
  env: Record<string, string>;
  expose: number[];
  entrypoint?: string[];
  cmd?: string[];
}

export type DockerfileRead = { ok: true; stage: FinalStage } | { ok: false; reason: string };

/**
 * Splits a command string the way a POSIX shell splits words: single and double quotes, and
 * backslash escapes. No expansion of any kind. Throws on an unterminated quote.
 */
export function shellWords(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i] as string;
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && i + 1 < input.length && '"\\$`\n'.includes(input[i + 1] as string)) {
        cur += input[++i];
      } else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === '\\' && i + 1 < input.length) {
      cur += input[++i];
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) out.push(cur);
      cur = '';
      inWord = false;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (quote !== null) throw new Error('unterminated quote');
  if (inWord) out.push(cur);
  return out;
}

/** Joins continuation lines and drops comments and parser directives. */
function instructions(text: string): { op: string; args: string }[] {
  const out: { op: string; args: string }[] = [];
  let buf = '';
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (buf === '' && /^\s*#/.test(line)) continue;
    if (line.endsWith('\\')) {
      buf += `${line.slice(0, -1)} `;
      continue;
    }
    buf += line;
    const m = /^\s*([A-Za-z]+)\s*(.*)$/s.exec(buf);
    if (m) out.push({ op: (m[1] as string).toUpperCase(), args: (m[2] as string).trim() });
    buf = '';
  }
  if (buf.trim() !== '') {
    const m = /^\s*([A-Za-z]+)\s*(.*)$/s.exec(buf);
    if (m) out.push({ op: (m[1] as string).toUpperCase(), args: (m[2] as string).trim() });
  }
  return out;
}

/** `$VAR` and `${VAR}` from the given variables; anything else (`${VAR:-x}`) fails. */
function substitute(s: string, vars: Readonly<Record<string, string>>): string {
  return s.replace(
    /\$(?:\{([^}]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (_, braced?: string, bare?: string) => {
      const name = braced ?? bare ?? '';
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        throw new Error(`unsupported substitution \${${name}}`);
      const v = vars[name];
      if (v === undefined) throw new Error(`undefined variable ${name}`);
      return v;
    },
  );
}

/** CMD and ENTRYPOINT: JSON exec form, or shell form run with `/bin/sh -c`. */
function commandForm(args: string): string[] {
  if (args.startsWith('[')) {
    const v: unknown = JSON.parse(args);
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
      throw new Error('exec form must be an array of strings');
    }
    return v;
  }
  return ['/bin/sh', '-c', args];
}

/** `ENV K=V K2="v 2"` or the legacy `ENV K value with spaces`. */
function envPairs(args: string, vars: Readonly<Record<string, string>>): [string, string][] {
  const first = /^([A-Za-z_][A-Za-z0-9_]*)(=?)/.exec(args);
  if (!first) throw new Error(`bad ENV: ${args}`);
  if (first[2] === '') {
    const value = args.slice((first[1] as string).length).trim();
    return [[first[1] as string, substitute(value, vars)]];
  }
  return shellWords(args).map((w) => {
    const eq = w.indexOf('=');
    if (eq <= 0) throw new Error(`bad ENV pair: ${w}`);
    return [w.slice(0, eq), substitute(w.slice(eq + 1), vars)];
  });
}

const posixJoin = (base: string, p: string): string => {
  const parts = (p.startsWith('/') ? p : `${base}/${p}`).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
};

export function readDockerfile(text: string): DockerfileRead {
  try {
    const ins = instructions(text);
    const globalArgs: Record<string, string> = {};
    const stageNames = new Set<string>();
    let stage: (FinalStage & { vars: Record<string, string> }) | null = null;

    for (const { op, args } of ins) {
      if (op === 'FROM') {
        const words = shellWords(args).filter((w) => !w.startsWith('--'));
        const ref = substitute(words[0] ?? '', globalArgs);
        if (ref === '') throw new Error('FROM without an image');
        if (stageNames.has(ref.toLowerCase())) {
          return { ok: false, reason: `final stage builds on stage ${ref}, which needs RUN steps` };
        }
        if (words[1]?.toLowerCase() === 'as' && words[2]) stageNames.add(words[2].toLowerCase());
        stage = { base: ref, workdir: '/', env: {}, expose: [], vars: { ...globalArgs } };
        continue;
      }
      if (op === 'ARG') {
        const [k, ...rest] = args.split('=');
        const name = (k ?? '').trim();
        const value = rest.length > 0 ? (shellWords(rest.join('='))[0] ?? '') : undefined;
        if (stage === null) {
          if (value !== undefined) globalArgs[name] = value;
        } else if (value !== undefined) stage.vars[name] = value;
        else if (globalArgs[name] !== undefined) stage.vars[name] = globalArgs[name];
        continue;
      }
      if (stage === null) {
        return { ok: false, reason: `${op} before the first FROM` };
      }
      switch (op) {
        case 'ENV':
          for (const [k, v] of envPairs(args, stage.vars)) {
            stage.env[k] = v;
            stage.vars[k] = v;
          }
          break;
        case 'WORKDIR':
          stage.workdir = posixJoin(stage.workdir, substitute(args, stage.vars));
          break;
        case 'EXPOSE':
          for (const w of shellWords(substitute(args, stage.vars))) {
            const port = Number(w.split('/')[0]);
            if (!Number.isInteger(port) || port < 1 || port > 65535)
              throw new Error(`bad EXPOSE ${w}`);
            stage.expose.push(port);
          }
          break;
        case 'CMD':
          stage.cmd = commandForm(args);
          break;
        case 'ENTRYPOINT':
          stage.entrypoint = commandForm(args);
          delete stage.cmd;
          break;
        default:
          // RUN, COPY, ADD, USER, LABEL, HEALTHCHECK and the rest: replaced by the split build or
          // overridden by the jail (USER is always nobody).
          break;
      }
    }
    if (stage === null) return { ok: false, reason: 'no FROM' };
    const final: FinalStage = {
      base: stage.base,
      workdir: stage.workdir,
      env: stage.env,
      expose: stage.expose,
      ...(stage.entrypoint === undefined ? {} : { entrypoint: stage.entrypoint }),
      ...(stage.cmd === undefined ? {} : { cmd: stage.cmd }),
    };
    return { ok: true, stage: final };
  } catch (err) {
    return { ok: false, reason: `unreadable Dockerfile: ${(err as Error).message}` };
  }
}
