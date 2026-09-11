import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveTargetRepo } from '../../src/orchestrator/targetRepo.js';

describe('resolveTargetRepo', () => {
  let localDir: string;

  beforeEach(() => {
    localDir = mkdtempSync(join(tmpdir(), 'aegis-target-repo-test-'));
  });

  afterEach(() => {
    rmSync(localDir, { recursive: true, force: true });
  });

  it('resolves an existing local path directly, without cloning', () => {
    const resolved = resolveTargetRepo(localDir, process.cwd());
    expect(resolved).toBe(localDir);
  });

  it('resolves a relative local path against the given cwd', () => {
    const resolved = resolveTargetRepo('.', localDir);
    expect(resolved).toBe(localDir);
  });

  it('throws a clear error for a local path that does not exist', () => {
    const missing = join(localDir, 'does-not-exist');
    expect(() => resolveTargetRepo(missing, process.cwd())).toThrow(/does not exist/);
  });

  // Cloning a real remote URL needs network access, which isn't guaranteed
  // in every environment this runs in (including CI) -- covered by the
  // local-path cases above plus manual verification instead.
});
