import type { BootHints, RepoId, RouteInfo, TargetRef, VulnClass } from '@affidavit/contracts';

/**
 * Corpus-only types. Anything that crosses a lane boundary (BootHints, TargetRef, VulnClass,
 * RepoId) is the contracts type, never a local copy.
 */

export interface LicenseNote {
  /** SPDX id observed in the fetched repo. */
  spdx: string;
  /** File in the fetched repo the license was read from. */
  file: string;
  note: string;
}

export interface LineRange {
  startLine: number;
  endLine: number;
}

export interface CodeLocation {
  file: string;
  range: LineRange;
}

/** Ground truth for one real issue, located in the pinned (vulnerable) tree. */
export interface Label {
  id: string;
  cls: VulnClass;
  title: string;
  cwe: string;
  file: string;
  range: LineRange;
  source: CodeLocation;
  route: RouteInfo;
  reachability: 'reachable' | 'unreachable' | 'unknown';
  notes: string;
}

export interface PatchRef {
  id: string;
  /** Path relative to the app's data directory. */
  path: string;
  sha256: string;
}

export interface Pin {
  repoUrl: string;
  commit: string;
  tree: string;
  /** sha256 of `git archive --format=tar <commit>`. */
  archiveSha256: string;
}

/** The pinned commit plus patches applied in order. No real commit exists for the result. */
export interface SafeVariant {
  id: string;
  appId: string;
  fixes: string;
  target: TargetRef;
  patches: PatchRef[];
  bootHints: BootHints;
  license: LicenseNote;
  notes: string;
}

/** Code a rule flags that cannot be exploited. No label points at it; no case may survive. */
export interface NegativeControl {
  id: string;
  appId: string;
  /** Never a known-safe tree: the control is the pinned commit plus patches, role below. */
  role: 'negative-control';
  /** The pinned commit the patches apply to (variant 'vulnerable'); not the differential safe tree. */
  base: TargetRef;
  /** Applied in order on the pinned commit. */
  patches: PatchRef[];
  file: string;
  /** Range in the patched tree. */
  range: LineRange;
  expectedRuleIds: string[];
  whyNotExploitable: string;
  bootHints: BootHints;
  license: LicenseNote;
}

export interface CorpusApp {
  id: string;
  name: string;
  repo: RepoId;
  pin: Pin;
  license: LicenseNote;
  bootHints: BootHints;
  bootNotes: string;
  labels: Label[];
  /** Upstream issue families deliberately not labeled, with the reason. */
  outOfScope: { issue: string; reason: string }[];
  safeVariants: SafeVariant[];
  negativeControls: NegativeControl[];
}

export interface CorpusIndex {
  apps: CorpusApp[];
}
