// The API a witness imports as '@affidavit/witness' (L2-05). Fixed code in the runner image.
import { readFileSync } from 'node:fs';
import { test } from 'vitest';

const input = JSON.parse(readFileSync('/runner/witness/input.json', 'utf8'));
let registered = false;

/** Every parameter combination, last parameter varying fastest (the artifact's index order). */
function combinations(space) {
  const size = space.reduce((n, p) => n * p.values.length, 1);
  return Array.from({ length: size }, (_, i) => {
    const params = {};
    let rest = i;
    for (let k = space.length - 1; k >= 0; k--) {
      const p = space[k];
      params[p.name] = p.values[rest % p.values.length];
      rest = Math.floor(rest / p.values.length);
    }
    return params;
  });
}

/**
 * Declares the witness family: `fn` runs once per parameter combination as its own test, and a
 * parameter passes when `fn` completes without a failed assertion or a throw.
 */
export function witness(fn) {
  if (registered) throw new Error('witness() may be called only once per witness');
  registered = true;
  combinations(input.params).forEach((params, i) => {
    test(`affidavit param ${i}`, () => fn(params, { target: input.target }));
  });
}
