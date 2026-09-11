import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listProjectFiles } from '../../src/orchestrator/agents/codebaseSnapshot.js';

describe('listProjectFiles', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aegis-snapshot-test-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns an empty list for an empty (greenfield) project', () => {
    expect(listProjectFiles(root)).toEqual([]);
  });

  it('lists real files with relative paths, recursively', () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), '');
    writeFileSync(join(root, 'README.md'), '');
    const files = listProjectFiles(root);
    expect(files).toContain(`src${sep}index.ts`);
    expect(files).toContain('README.md');
  });

  it('excludes noise directories like node_modules and .git', () => {
    mkdirSync(join(root, 'node_modules', 'some-pkg'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'some-pkg', 'index.js'), '');
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', 'HEAD'), '');
    writeFileSync(join(root, 'real-file.ts'), '');

    const files = listProjectFiles(root);
    expect(files).toEqual(['real-file.ts']);
  });

  it('respects a bound on the number of files returned', () => {
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(root, `file-${i}.ts`), '');
    }
    expect(listProjectFiles(root, 5)).toHaveLength(5);
  });
});
