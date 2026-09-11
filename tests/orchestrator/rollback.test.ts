import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChangeTracker } from '../../src/orchestrator/resilience/rollback.js';

describe('ChangeTracker', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'aegis-rollback-test-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('deletes a newly-created file on rollback', () => {
    const tracker = new ChangeTracker(projectRoot);
    tracker.writeFile('new-file.txt', 'hello');
    expect(existsSync(join(projectRoot, 'new-file.txt'))).toBe(true);

    tracker.rollback();
    expect(existsSync(join(projectRoot, 'new-file.txt'))).toBe(false);
  });

  it('restores the previous content of a modified file on rollback', () => {
    writeFileSync(join(projectRoot, 'existing.txt'), 'original content');
    const tracker = new ChangeTracker(projectRoot);
    tracker.writeFile('existing.txt', 'overwritten content');
    expect(readFileSync(join(projectRoot, 'existing.txt'), 'utf-8')).toBe('overwritten content');

    tracker.rollback();
    expect(readFileSync(join(projectRoot, 'existing.txt'), 'utf-8')).toBe('original content');
  });

  it('unwinds multiple writes to the same path back to the original state', () => {
    writeFileSync(join(projectRoot, 'multi.txt'), 'v0');
    const tracker = new ChangeTracker(projectRoot);
    tracker.writeFile('multi.txt', 'v1');
    tracker.writeFile('multi.txt', 'v2');

    tracker.rollback();
    expect(readFileSync(join(projectRoot, 'multi.txt'), 'utf-8')).toBe('v0');
  });

  it('reports every changed absolute path', () => {
    const tracker = new ChangeTracker(projectRoot);
    tracker.writeFile('a.txt', '1');
    tracker.writeFile('b.txt', '2');
    expect(tracker.changedFiles()).toEqual([join(projectRoot, 'a.txt'), join(projectRoot, 'b.txt')]);
  });

  it('exposes the actual content written, for policy scanning', () => {
    const tracker = new ChangeTracker(projectRoot);
    tracker.writeFile('a.txt', 'hello world');
    expect(tracker.writtenContent()).toEqual([{ path: join(projectRoot, 'a.txt'), content: 'hello world' }]);
  });
});
