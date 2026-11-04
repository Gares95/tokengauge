// The production (node-backed) snapshot directory lister against a REAL
// directory. Directory mode reads only the configured directory: a hash-named
// SYMLINK inside it must never be followed, or any file it points at (outside
// the directory) would be read and could even be shown on the card.

import * as assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { listSnapshotDirectoryOnDisk } from '../../../src/cockpit/snapshotDirectoryOnDisk';
import { readSnapshotDirectoryCandidate } from '../../../src/core/cockpit/readSnapshotDirectory';
import { IdHasher } from '../../../src/security/IdHasher';

const hasher = new IdHasher('test-salt-0123456789');
const WS = 'aaaaaaaaaaaaaaaa';
const S1 = '1111111111111111';
const S2 = '2222222222222222';

function body(session: string, usedPct: number, model: string): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    session_id_hash: session,
    workspace_hash: WS,
    model: { id: model },
    rate_limits: { five_hour: { used_percentage: usedPct, resets_at: 4_102_444_800 } },
  });
}

function withLayout(fn: (root: string, dir: string, outside: string) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), 'tokengauge-ondisk-'));
  try {
    const dir = path.join(root, 'snapshots');
    const outside = path.join(root, 'outside');
    mkdirSync(dir);
    mkdirSync(outside);
    fn(root, dir, outside);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Some hosts (Windows without the symlink privilege) cannot create symlinks.
function trySymlink(target: string, linkPath: string, type?: 'dir'): boolean {
  try {
    symlinkSync(target, linkPath, type);
    return true;
  } catch {
    return false;
  }
}

function readDir(dir: string) {
  const reads: string[] = [];
  const result = readSnapshotDirectoryCandidate(dir, {
    listDir: listSnapshotDirectoryOnDisk,
    readFile: (p) => {
      reads.push(p);
      return readFileSync(p, 'utf8');
    },
    join: path.join,
    hasher,
    now: () => new Date(),
  });
  return { result, reads };
}

suite('snapshotDirectoryOnDisk — directory boundary', () => {
  test('A hash-named symlink to a snapshot OUTSIDE the directory is never read', function () {
    withLayout((_root, dir, outside) => {
      const target = path.join(outside, 'elsewhere.json');
      writeFileSync(target, body(S2, 77, 'outside-model'));
      const link = path.join(dir, `${WS}-${S2}.json`);
      if (!trySymlink(target, link)) this.skip();

      const { result, reads } = readDir(dir);
      assert.equal(result.status, 'snapshot_dir_no_active_writer');
      assert.equal(result.candidate, undefined);
      assert.deepEqual(reads, [], 'the symlinked entry must not be opened');
    });
  });

  test('A symlinked entry never adds a writer or a value next to a real session file', function () {
    withLayout((_root, dir, outside) => {
      writeFileSync(path.join(dir, `${WS}-${S1}.json`), body(S1, 42, 'real-model'));
      const target = path.join(outside, 'elsewhere.json');
      writeFileSync(target, body(S2, 99, 'outside-model'));
      if (!trySymlink(target, path.join(dir, `${WS}-${S2}.json`))) this.skip();

      const { result } = readDir(dir);
      assert.equal(result.status, 'snapshot_dir_loaded');
      assert.equal(result.activeWriters, 1);
      assert.equal(result.candidate?.session?.usedPct, 42);
      assert.equal(result.candidate?.model, 'real-model');
    });
  });

  test('A configured directory that is itself a symlink still works (explicit user path)', function () {
    withLayout((root, dir) => {
      writeFileSync(path.join(dir, `${WS}-${S1}.json`), body(S1, 42, 'real-model'));
      const linkedDir = path.join(root, 'linked-snapshots');
      if (!trySymlink(dir, linkedDir, 'dir')) this.skip();

      const { result } = readDir(linkedDir);
      assert.equal(result.status, 'snapshot_dir_loaded');
      assert.equal(result.candidate?.session?.usedPct, 42);
    });
  });

  test('Stale real files stay inactive; the lister reports their true mtime', () => {
    withLayout((_root, dir) => {
      const file = path.join(dir, `${WS}-${S1}.json`);
      writeFileSync(file, body(S1, 42, 'real-model'));
      const old = Date.now() / 1000 - 3600;
      utimesSync(file, old, old);
      const listing = listSnapshotDirectoryOnDisk(dir);
      assert.equal(listing.overCapacity, false);
      assert.equal(listing.entries.length, 1);
      assert.ok(Math.abs((listing.entries[0]?.mtimeMs ?? 0) - old * 1000) < 2_000);
      assert.equal(readDir(dir).result.status, 'snapshot_dir_no_active_writer');
    });
  });
});
