export class ChecksumMismatchError extends Error {
  expected: string;
  actual: string;
  constructor(what: string, expected: string, actual: string);
}

export function fetchPinned(opts: {
  repoUrl: string;
  commit: string;
  tree: string;
  archiveSha256: string;
  dest: string;
  patches?: { path: string; sha256: string }[];
  allowLocal?: boolean;
}): Promise<void>;

export function applyPatches(opts: {
  dir: string;
  patches: { path: string; sha256: string }[];
}): Promise<void>;
