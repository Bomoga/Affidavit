// buildInvocation is deliberately not exported here: it does not check the snapshot, so the only
// supported way to run a tool outside this module is runTool, which takes a QuarantinedSnapshot.
export * from './manifest.js';
export {
  SEMGREP_CANARY,
  SEMGREP_NO_TMP_EXIT,
  canaryRoot,
  ToolDisabledError,
  ToolOptionError,
  type ToolInvocation,
  type ToolRunOptions,
} from './invocations.js';
export * from './quarantine.js';
export * from './lockfiles.js';
export * from './run.js';
export * from './unscannable.js';
export { fontFormatOf, FONT_HEAD_BYTES, type FontFormat } from './fonts.js';
export {
  PROOF_CAPS,
  WINDOW_PROOF_NAMES,
  inWindowProofClass,
  measureText,
  statsProveCoverage,
  type TextStats,
} from './windowproof.js';
export {
  WindowsDirNotFreshError,
  remapWindowReport,
  writeWindows,
  OVERLAP_BYTES,
  WINDOW_BYTES,
  type WindowEntry,
} from './windows.js';
export { NonUtf8NameError } from './walk.js';
