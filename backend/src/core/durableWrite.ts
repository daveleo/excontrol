import { openSync, writeSync, fsyncSync, closeSync, renameSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Write a file so that after a power cut it holds either the old or the new content — never
 * nothing and never half: temp file → fsync → rename over the target → fsync the directory.
 *
 * Measured on a Raspberry Pi (ext4, SD card): files written less than ~30 s before a hard
 * reset without fsync came back 0 bytes. tmp+rename alone is only safe while a previous
 * version exists (ext4's auto_da_alloc heuristic) — not for a first save, and not on every
 * filesystem.
 */
export function writeFileDurable(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  // Persist the rename itself. Windows can't open a directory (EISDIR/EPERM) — NTFS journals
  // the rename, so skipping it there is fine.
  try {
    const dfd = openSync(dirname(file), "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    /* not supported on this platform */
  }
}
