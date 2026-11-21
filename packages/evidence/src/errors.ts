/**
 * A bundle failed its integrity check. `exhibitId` names the exhibit whose bytes or reference were
 * wrong (`casefile`, `verdict` and `manifest` name those files), so a reviewer knows what was
 * tampered with. Thrown by `openBundle`; `replay` turns it into a failed report.
 */
export class BundleIntegrityError extends Error {
  constructor(
    readonly exhibitId: string | undefined,
    readonly reason: string,
  ) {
    super(exhibitId === undefined ? reason : `${exhibitId}: ${reason}`);
    this.name = 'BundleIntegrityError';
  }
}

/** A store returned bytes whose SHA-256 is not the address they were stored under. */
export class EvidenceCorruptError extends Error {
  constructor(readonly sha256: string) {
    super(`stored object ${sha256} does not hash to its address`);
    this.name = 'EvidenceCorruptError';
  }
}
