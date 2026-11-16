import { open, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/**
 * gitleaks decides by a file's leading bytes whether it is text, and silently skips what looks
 * binary (PDF, ELF, zip, gzip, xz, 7z, wasm, class and so on; an archive it cannot unpack is
 * dropped with only a stderr line). The exit code stays 0. A hostile repo can hide a secret by
 * giving a text file a binary-looking header, and UTF-16 text is skipped the same way.
 *
 * So discovery sniffs the same bytes on the host and lists what gitleaks may not have scanned.
 * Conservative on purpose: archives gitleaks can unpack are listed too, because the report cannot
 * say which ones it managed to read.
 */
const MAGIC: readonly (readonly number[])[] = [
  [0x25, 0x50, 0x44, 0x46], // %PDF
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0x50, 0x4b, 0x03, 0x04], // zip, jar, docx
  [0x1f, 0x8b], // gzip
  [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], // xz
  [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], // 7z
  [0x00, 0x61, 0x73, 0x6d], // wasm
  [0xca, 0xfe, 0xba, 0xbe], // java class, mach-o fat
  [0x89, 0x50, 0x4e, 0x47], // png
  [0x47, 0x49, 0x46, 0x38], // gif
  [0xff, 0xd8, 0xff], // jpeg
  [0x42, 0x5a, 0x68], // bzip2
  [0x52, 0x61, 0x72, 0x21], // rar
];

const SNIFF_BYTES = 8192;

export function looksBinary(head: Uint8Array): boolean {
  if (MAGIC.some((m) => m.every((b, i) => head[i] === b))) return true;
  return head.includes(0x00); // NUL bytes: binary, or UTF-16 text
}

/** Relative paths (posix separators) of files gitleaks may skip as binary. Never follows symlinks. */
export async function findGitleaksUnscannable(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        let fh;
        try {
          fh = await open(full, 'r');
        } catch {
          // Unreadable to us (for example mode 000) means unreadable to the jailed tool as well.
          found.push(relative(dir, full).split(sep).join('/'));
          continue;
        }
        try {
          const buf = Buffer.alloc(SNIFF_BYTES);
          const { bytesRead } = await fh.read(buf, 0, SNIFF_BYTES, 0);
          if (looksBinary(buf.subarray(0, bytesRead))) {
            found.push(relative(dir, full).split(sep).join('/'));
          }
        } finally {
          await fh.close();
        }
      }
    }
  };
  await walk(dir);
  return found.sort();
}
