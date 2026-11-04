// The node-backed lister for per-session snapshot DIRECTORY mode.
//
// Kept apart from the pure reader so the exact production wiring can be tested
// against a real directory. Entries are stat'ed with lstat, never stat: a
// symlink is not a plain file, so a hash-named symlink can never pull a file
// from outside the configured directory into the cockpit. (The configured
// directory itself may be a symlink; the user chose that path explicitly.)

import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  listSnapshotDirectory,
  type SnapshotDirListing,
} from '../core/cockpit/readSnapshotDirectory';

export function listSnapshotDirectoryOnDisk(dirPath: string): SnapshotDirListing {
  return listSnapshotDirectory(dirPath, {
    readdir: (dir) => readdirSync(dir),
    statEntry: (entry) => lstatSync(entry),
    join,
  });
}
