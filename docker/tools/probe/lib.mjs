// Pure helpers for archive-names.mjs, split out so unit tests can check them without Docker.

/**
 * The text of the names file the container reads with `while IFS= read -r n`. Every name,
 * the last one too, must end in a newline: `read` returns non-zero on a final unterminated line
 * and the loop would skip it, so the last name would never be created.
 */
export function namesFileContent(names) {
  return names.length === 0 ? '' : `${names.join('\n')}\n`;
}

/**
 * Exit code of the probe: 1 when ARCHIVE_NAME is wrong in either direction, that is when gitleaks
 * dropped a name the rule does not match (`shouldScan`) or scanned a name the rule says it drops
 * (`shouldDrop`, an over-match).
 */
export function probeExitCode(shouldDrop, shouldScan) {
  return shouldDrop.length > 0 || shouldScan.length > 0 ? 1 : 0;
}
