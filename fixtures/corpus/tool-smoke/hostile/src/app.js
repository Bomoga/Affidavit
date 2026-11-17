// Harmless fixture: a deliberately unsafe pattern for the Semgrep smoke run.
export function run(input) {
  return eval(input);
}
